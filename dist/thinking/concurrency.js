// thinking/concurrency.ts
// empirical concurrency scaler for local/cloud LLM endpoints.
//
// The cloud endpoint is bounded by CONCURRENCY of requests, not RPS,
// and the bound is per-user/per-model — never hardcoded. The scaler
// discovers it with an exponential search:
//
//   - discovering: double the level on clean rounds (2 → 4 → 8 → 16 …)
//     until the FIRST 429/"too many requests" fires. That level is the
//     upper bound (firstBad). The last fully-clean level is lastGood.
//   - settling: binary search between lastGood and firstBad — test the
//     midpoint; 429s pull firstBad down, clean rounds pull lastGood up.
//     When they're adjacent, settle at lastGood and CACHE it.
//   - stable: guard only — a 429 here means the server lowered the
//     bound, so re-enter settling around it; latency degradation still
//     steps down one level (protects local GPUs, never stops discovery).
//   - timeouts/connection errors are NOT bound signals — halve + back
//     off with exponential jitter as before.
//
// The ceiling is cached per model in %TEMP%\deepthink-concurrency.json
// so a fresh process starts warm. Under multi-pipeline contention
// (benchmark queue 2) the shared cache converges each instance toward
// bound/2; solo runs converge at the full bound. The first real 429
// body is logged verbatim so the exact message is on record.
//
// export { AdaptiveConcurrency, isRateLimitError, loadConcurrencyCache, saveConcurrencyCache };
import fs from 'fs';
import os from 'os';
import path from 'path';
const CACHE_PATH = path.join(os.tmpdir(), 'deepthink-concurrency.json');
/** is this error a rate-limit or overload signal? */
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
 * AdaptiveConcurrency — exponential-search discovery of the endpoint's
 * concurrency ceiling. Thread-safe enough for one Deepthink instance;
 * call every method from the async loop.
 */
export class AdaptiveConcurrency {
    model;
    current;
    min;
    max;
    probeCalls; // clean calls before doubling
    state;
    /** highest level proven clean (0 rate-limits in a full round) */
    lastGood = 0;
    /** lowest level that produced a rate limit; Infinity until found */
    firstBad = Infinity;
    stateBeforeBackoff = 'discovering';
    cleanCount = 0;
    backoffUntil = 0;
    backoffBaseMs;
    consecutivePressure = 0;
    lastLatencyAvg = 0;
    latencies = [];
    loggedFirst429 = false;
    onEvent;
    constructor(opts) {
        this.model = opts.model;
        const cached = loadConcurrencyCache()[opts.model];
        const start = opts.start ?? 2;
        this.current = Math.max(start, cached?.level ?? 0) || start;
        this.min = opts.min ?? 1;
        this.max = opts.max ?? 32;
        this.probeCalls = opts.probeCalls ?? 12;
        this.state = 'discovering';
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
            this.state = this.stateBeforeBackoff;
            this.cleanCount = 0;
            this.onEvent(`[CONC] backoff over — resuming ${this.state} at ${this.current} concurrent`);
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
            // top of the ladder with zero 429s — the ceiling is above max
            this.lastGood = this.max;
            this.settle(this.max);
            return;
        }
        this.current = Math.min(this.current * 2, this.max);
        this.cleanCount = 0;
        this.onEvent(`[CONC] clean round — doubled to ${this.current}`);
    }
    /** 429 seen — record the bound and binary-search down to the ceiling */
    hitRateLimit(stats) {
        // the 429 fired at `current` — that level is the new upper bound
        this.firstBad = Math.min(this.firstBad, this.current);
        this.lastGood = Math.min(this.lastGood, this.current - 1);
        if (!this.loggedFirst429) {
            this.loggedFirst429 = true;
            const detail = stats ? ` (${stats.rateLimited}/${stats.calls} calls this round)` : '';
            this.onEvent(`[CONC] RATE LIMIT at concurrency ${this.current}${detail} — upper bound is below this, binary-searching from ${this.lastGood}`);
        }
        this.enterSettling(); // set state + repoint `current` at the midpoint
        this.backoffBriefly(); // then let the burst drain (keeps the settling state)
    }
    enterSettling() {
        if (this.state === 'settling') {
            this.reprobeMidpoint();
            return;
        }
        this.state = 'settling';
        this.cleanCount = 0;
        this.reprobeMidpoint();
    }
    /** point `current` at the midpoint between lastGood and firstBad */
    reprobeMidpoint() {
        if (this.firstBad - this.lastGood <= 1) {
            this.settle(this.lastGood);
            return;
        }
        const mid = Math.ceil((this.lastGood + this.firstBad) / 2);
        if (mid === this.current) {
            // same level, still unproven — keep testing it
            this.cleanCount = 0;
            return;
        }
        this.current = mid;
        this.cleanCount = 0;
        this.onEvent(`[CONC] settling: testing ${this.current} (good ${this.lastGood} … bad ${this.firstBad})`);
    }
    /** verdicts during settling need fewer calls than discovery rounds */
    roundCalls() {
        return Math.max(3, Math.min(this.probeCalls, this.current));
    }
    settle(level) {
        this.current = Math.max(level, this.min);
        this.state = 'stable';
        this.cleanCount = 0;
        this.onEvent(`[CONC] settled at ${this.current} concurrent — ceiling ${this.firstBad === Infinity ? 'unknown (≥ max)' : `under ${this.firstBad}`}`);
        this.save(); // persist now so sibling instances converge mid-run
    }
    halve(reason) {
        this.current = Math.max(Math.floor(this.current / 2), this.min);
        this.consecutivePressure++;
        const backoffMs = Math.min(this.backoffBaseMs * Math.pow(2, this.consecutivePressure) + Math.floor(Math.random() * 200), 60_000);
        this.stateBeforeBackoff = this.state;
        this.backoffUntil = Date.now() + backoffMs;
        this.state = 'backoff';
        this.cleanCount = 0;
        this.onEvent(`[CONC] ${reason} — halved to ${this.current}, backing off ${backoffMs}ms`);
    }
    /** short drain pause after hitting the bound — not a punishment, just letting the burst drain */
    backoffBriefly() {
        const ms = Math.min(400 + Math.floor(Math.random() * 400), 2000);
        this.stateBeforeBackoff = this.state;
        this.backoffUntil = Date.now() + ms;
        this.state = 'backoff';
        this.cleanCount = 0;
    }
    /** call this after every batch of `n` concurrent calls finishes */
    onBatch(stats) {
        // 429 = we exceeded the concurrency ceiling. Always a bound signal.
        if (stats.rateLimited > 0) {
            this.hitRateLimit(stats);
            return;
        }
        // timeouts/connection errors are throttle symptoms, not bound data
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
        if (this.state === 'discovering') {
            this.cleanCount += stats.calls;
            this.lastGood = Math.max(this.lastGood, this.current);
            if (this.cleanCount >= this.probeCalls)
                this.double();
            return;
        }
        if (this.state === 'settling') {
            this.cleanCount += stats.calls;
            this.lastGood = Math.max(this.lastGood, this.current);
            if (this.cleanCount >= this.roundCalls())
                this.reprobeMidpoint();
            return;
        }
        if (this.state === 'stable') {
            // latency guard for local GPUs — steps down, never re-enters discovery
            if (this.lastLatencyAvg > 0 && stats.avgLatencyMs > this.lastLatencyAvg * 1.5) {
                this.current = Math.max(Math.floor(this.current * 0.75), this.min);
                this.lastGood = Math.min(this.lastGood, this.current);
                this.onEvent(`[CONC] latency ${stats.avgLatencyMs.toFixed(0)}ms vs ${this.lastLatencyAvg.toFixed(0)}ms — stepped down to ${this.current}`);
            }
        }
        this.lastLatencyAvg = stats.avgLatencyMs;
    }
    /** a single call errored outside a batch — same rules apply */
    onError(err) {
        if (isRateLimitError(err)) {
            if (this.state === 'backoff')
                return;
            this.hitRateLimit();
            return;
        }
        if (isTimeoutError(err)) {
            this.halve('timeout hit');
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
