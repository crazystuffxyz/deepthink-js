// internet/ollamaSearch.ts
// Ollama-native web search, layered:
//   1. device daemon  POST $OLLAMA_HOST/api/experimental/web_search — no key
//      needed when the machine is signed in (`ollama signin`); the daemon
//      signs the forward with the local identity key.
//   2. ollama.com     POST https://ollama.com/api/web_search — needs
//      OLLAMA_API_KEY (Bearer).
//   3. JS SDK         same ollama.com endpoint; kept last because it wants a
//      key too and a stale SDK can silently drop max_results.
// A tier that can't authenticate is skipped with one log line — a missing
// API key is never a fatal "no API key" dead end.
import axios from './axios.js';
import { Ollama } from 'ollama';
const WEB_SEARCH_URL = 'https://ollama.com/api/web_search';
function host() {
    const h = (process.env.OLLAMA_HOST || '').trim() || 'http://127.0.0.1:11434';
    return h.replace(/\/+$/, '');
}
// same timeout-fetch trick as providers/index.ts — a hung search must die
function makeTimeoutFetch(timeoutMs) {
    return ((input, init) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const signal = init?.signal;
        if (signal) {
            if (signal.aborted)
                ctrl.abort();
            else
                signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
        return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    });
}
class Concurrency {
    _limit;
    _running;
    _queue;
    constructor(limit) {
        this._limit = limit;
        this._running = 0;
        this._queue = [];
    }
    run(task) {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                this._running++;
                try {
                    resolve(await task());
                }
                catch (e) {
                    reject(e);
                }
                finally {
                    this._running--;
                    if (this._queue.length)
                        this._queue.shift()();
                }
            };
            this._running < this._limit ? execute() : this._queue.push(execute);
        });
    }
}
const _clientQueue = new Concurrency(3);
const say = (m) => { if (process.stdout?.write)
    process.stdout.write(m); };
let _daemonState = 'unknown';
let _notifiedNoKey = false;
function daemonVerdict(err) {
    const e = err;
    const code = String(e?.code || '');
    if (e?.response?.status === 401 || e?.response?.status === 403)
        return 'signed-out';
    if (e?.response?.status === 404)
        return 'no-endpoint';
    if (code === 'ECONNREFUSED' || /ENOTFOUND|ECONNRESET|socket|network/i.test(String(e?.message)))
        return 'down';
    return 'down';
}
const daemonHint = {
    'signed-out': 'not signed in — run `ollama signin`, falling through',
    'no-endpoint': 'daemon lacks /api/experimental/web_search (update ollama), falling through',
    down: 'daemon unreachable, falling through'
};
async function probeDaemon() {
    if (_daemonState === 'ok')
        return true;
    if (_daemonState !== 'unknown')
        return false;
    try {
        // /api/me is free and tells us the machine is signed in (plan, name)
        await axios.post(`${host()}/api/me`, {}, { timeout: 4000 });
        _daemonState = 'ok';
        return true;
    }
    catch (err) {
        _daemonState = daemonVerdict(err);
        if (_daemonState === 'signed-out')
            say(`[ollamaSearch/daemon] ${daemonHint['signed-out']}\n`);
        else
            say(`[ollamaSearch/daemon] no device search (${_daemonState})\n`);
        return false;
    }
}
async function searchViaDaemon(query, maxResults) {
    const t0 = Date.now();
    const response = await axios.post(`${host()}/api/experimental/web_search`, { query, max_results: maxResults }, { headers: { 'Content-Type': 'application/json' }, timeout: 12_000 });
    const results = normalise(response.data?.results);
    say(`[ollamaSearch/daemon] ${results.length} results in ${Date.now() - t0}ms\n`);
    return results;
}
// --- ollama.com tiers (need OLLAMA_API_KEY) -----------------------------
// 429 → one spaced retry, then let the tier fail (the next engine takes over)
async function with429Retry(run) {
    try {
        return await run();
    }
    catch (err) {
        if (err?.response?.status !== 429)
            throw err;
        await new Promise(r => setTimeout(r, 900));
        return await run();
    }
}
async function searchViaApiKey(query, maxResults, apiKey) {
    const t0 = Date.now();
    const response = await with429Retry(() => axios.post(WEB_SEARCH_URL, { query, max_results: maxResults }, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'deepthink-research-agent/1.0'
        },
        timeout: 12_000
    }));
    const results = normalise(response.data?.results);
    say(`[ollamaSearch/api-key] ${results.length} results in ${Date.now() - t0}ms\n`);
    return results;
}
// SDK 0.6.x: webSearch() takes { query } only (string form throws), hardcodes
// ollama.com, and needs the key via client headers — auth it here or skip.
async function searchViaClient(query, apiKey) {
    const t0 = Date.now();
    const client = new Ollama({
        fetch: makeTimeoutFetch(15_000),
        headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (typeof client.webSearch !== 'function') {
        throw new Error('ollama package does not expose webSearch(). Run: npm install ollama@latest');
    }
    const response = await _clientQueue.run(() => client.webSearch({ query }));
    const results = normalise(response?.results);
    say(`[ollamaSearch/client] ${results.length} results in ${Date.now() - t0}ms\n`);
    return results;
}
function normalise(rawResults) {
    if (!Array.isArray(rawResults))
        return [];
    return rawResults.map(r => {
        const rr = r;
        let hostname = '';
        const link = String(rr.url || rr.link || '').trim();
        try {
            hostname = new URL(link).hostname;
        }
        catch { /* ignore */ }
        return {
            title: String(rr.title || '').trim(),
            link,
            snippet: String(rr.content || rr.snippet || '').trim(),
            cite: hostname
        };
    }).filter(r => r.link);
}
// --- public surface -----------------------------------------------------
export async function getOllamaSearchResults(query, maxResults = 5) {
    const max = Math.min(Math.max(1, Math.floor(Number(maxResults) || 5)), 10);
    const apiKey = process.env.OLLAMA_API_KEY;
    const daemonLive = await probeDaemon();
    const tiers = [];
    if (daemonLive)
        tiers.push(['daemon', () => searchViaDaemon(query, max)]);
    if (apiKey) {
        tiers.push(['api-key', () => searchViaApiKey(query, max, apiKey)]);
        tiers.push(['client', () => searchViaClient(query, apiKey)]);
    }
    else if (!_notifiedNoKey) {
        _notifiedNoKey = true;
        say('[ollamaSearch] no OLLAMA_API_KEY — ollama.com tiers skipped; device daemon + SearXNG still in play\n');
    }
    for (const [name, run] of tiers) {
        try {
            const results = await run();
            if (results.length > 0)
                return results;
            say(`[ollamaSearch/${name}] 0 results — next tier\n`);
        }
        catch (err) {
            if (name === 'daemon')
                _daemonState = daemonVerdict(err);
            say(`[ollamaSearch/${name}] ${String(err?.message ?? err).slice(0, 90)} — next tier\n`);
        }
    }
    return [];
}
// LLM-free degraded-query builder for a last-chance retry in the engine that
// wraps this module: drop stopwords/punctuation, keep the strongest tokens.
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with',
    'how', 'what', 'whats', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'best', 'vs',
    'versus', 'latest', 'news', 'today', 'current', 'about', 'from', 'by', 'at', 'as', 'it',
    'its', 'that', 'this', 'your', 'me', 'my', 'can', 'you', 'please']);
export function reformulateQuery(q) {
    const toks = String(q || '').toLowerCase().replace(/[^a-z0-9\s.+#-]/g, ' ').split(/\s+/).filter(Boolean);
    const keep = toks.filter(t => !STOP.has(t));
    const out = (keep.length >= 2 ? keep : toks).slice(0, 8).join(' ').trim();
    return out && out !== String(q).toLowerCase() ? out : null;
}
