// thinking/concurrency.ts
// empirical concurrency scaler for local/cloud LLM endpoints.
//
// Rule set:
//   - start at 2 parallel calls
//   - after `probeCalls` clean calls, double the concurrency
//   - on 429 / timeout / connection error: halve, then back off with
//     exponential jitter before probing again
//   - when doubling stops improving throughput (latency climbs or
//     errors appear), settle at the last stable level
//
// The discovered ceiling is cached per model in a json file so a
// fresh process can start from the known-good level instead of
// probing from 2 every time.
//
// export { AdaptiveConcurrency, isRateLimitError, loadConcurrencyCache, saveConcurrencyCache };
import fs from 'fs';
import os from 'os';
import path from 'path';
const CACHE_PATH = path.join(os.tmpdir(), 'deepthink-concurrency.json');
/** is this error a rate-limit or overload signal we must back off from? */
export function isRateLimitError(err) {
    const m = String(err?.message || err || '');
    return /429|503|too many requests|rate.?limit|quota|overloaded|capacity/i.test(m);
}
export function isTimeoutError(err) {
    const m = String(err?.message || err || '');
    return /timeout|timed out|ECONNRESET|fetch failed|socket hang up|aborted/i.test(m);
}
export function loadConcurrencyCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
    catch {
        return {};
    }
}
export function saveConcurrencyCache(cache) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
    }
    catch {
        // cache is best-effort; never crash the pipeline over it
    }
}
/**
 * AdaptiveConcurrency — doubles after clean probes, halves on
 * pressure, backs off with jitter. Thread-safe enough for one
 * Deepthink instance; call every method from the async loop.
 */
export class AdaptiveConcurrency {
    model;
    current;
    min;
    max;
    probeCalls; // clean calls before doubling
    state;
    cleanCount = 0;
    backoffUntil = 0;
    backoffBaseMs;
    consecutivePressure = 0;
    lastLatencyAvg = 0;
    latencies = [];
    onEvent;
    constructor(opts) {
        this.model = opts.model;
        const cached = loadConcurrencyCache()[opts.model];
        const start = opts.start ?? 2;
        this.current = Math.max(start, cached?.level ?? 0) || start;
        this.min = opts.min ?? 1;
        this.max = opts.max ?? 32;
        this.probeCalls = opts.probeCalls ?? 12;
        this.state = 'probing';
        this.backoffBaseMs = opts.backoffBaseMs ?? 800;
        this.onEvent = opts.onEvent ?? (() => { });
    }
    get level() {
        return this.current;
    }
    /** can we dispatch a call right now? (false during backoff) */
    canDispatch() {
        if (this.state !== 'backoff')
            return true;
        if (Date.now() >= this.backoffUntil) {
            this.state = 'probing';
            this.cleanCount = 0;
            this.onEvent(`[CONC] backoff over — resuming at ${this.current} concurrent`);
            return true;
        }
        return false;
    }
    waitForDispatch() {
        if (this.canDispatch())
            return Promise.resolve();
        const wait = this.backoffUntil - Date.now();
        return new Promise((r) => setTimeout(r, Math.max(0, wait)));
    }
    double() {
        if (this.current >= this.max) {
            this.state = 'stable';
            return;
        }
        this.current = Math.min(this.current * 2, this.max);
        this.cleanCount = 0;
        this.onEvent(`[CONC] clean batch — doubled to ${this.current}`);
    }
    halve(reason) {
        this.current = Math.max(Math.floor(this.current / 2), this.min);
        this.consecutivePressure++;
        const backoffMs = Math.min(this.backoffBaseMs * Math.pow(2, this.consecutivePressure) + Math.floor(Math.random() * 200), 60_000);
        this.backoffUntil = Date.now() + backoffMs;
        this.state = 'backoff';
        this.cleanCount = 0;
        this.onEvent(`[CONC] ${reason} — halved to ${this.current}, backing off ${backoffMs}ms`);
    }
    /** call this after every batch of `n` concurrent calls finishes */
    onBatch(stats) {
        if (stats.rateLimited > 0) {
            this.halve(`rate-limited (${stats.rateLimited}/${stats.calls})`);
            return;
        }
        if (stats.timeouts > 0 || stats.errors > 0) {
            const pct = (stats.errors + stats.timeouts) / Math.max(1, stats.calls);
            if (pct >= 0.25) {
                this.halve(`${stats.errors + stats.timeouts} errors/${stats.calls} calls`);
                return;
            }
        }
        this.latencies.push(stats.avgLatencyMs);
        if (this.latencies.length > 5)
            this.latencies.shift();
        if (this.state === 'probing') {
            this.cleanCount += stats.calls;
            if (this.cleanCount >= this.probeCalls)
                this.double();
            return;
        }
        if (this.state === 'stable') {
            // throughput check: if latency degraded >50% vs previous batch,
            // the extra concurrency is hurting — step down one level.
            if (this.lastLatencyAvg > 0 && stats.avgLatencyMs > this.lastLatencyAvg * 1.5) {
                this.current = Math.max(Math.floor(this.current * 0.75), this.min);
                this.onEvent(`[CONC] latency ${stats.avgLatencyMs.toFixed(0)}ms vs ${this.lastLatencyAvg.toFixed(0)}ms — stepped down to ${this.current}`);
            }
        }
        this.lastLatencyAvg = stats.avgLatencyMs;
    }
    /** a single call errored outside a batch — same rules apply */
    onError(err) {
        if (isRateLimitError(err) || isTimeoutError(err)) {
            this.halve(isRateLimitError(err) ? 'rate limit hit' : 'timeout hit');
        }
    }
    /** persist the discovered level so the next process starts warm */
    save() {
        if (this.current <= 1)
            return;
        const cache = loadConcurrencyCache();
        cache[this.model] = { level: this.current, when: Date.now() };
        saveConcurrencyCache(cache);
    }
}
