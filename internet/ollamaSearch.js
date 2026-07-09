// internet/ollamaSearch.ts
// Ollama Web Search (api-key tier + JS-client tier).
import axios from './axios.js';
import { Ollama } from 'ollama';
const ollama = 'https://ollama.com/api/web_search';
const ollama1 = 3;
const _ollamaClient = new Ollama();
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
const _clientQueue = new Concurrency(ollama1);
let _webSearchSignature = null;
async function callWebSearch(query) {
    if (typeof _ollamaClient.webSearch !== 'function') {
        throw new Error('ollama package does not expose webSearch(). Run: npm install ollama@latest');
    }
    if (_webSearchSignature === 'object')
        return _ollamaClient.webSearch({ query });
    if (_webSearchSignature === 'string')
        return _ollamaClient.webSearch(query);
    try {
        const result = await _ollamaClient.webSearch({ query });
        _webSearchSignature = 'object';
        if (process.stdout?.write)
            process.stdout.write('[ollamaSearch/client] signature detected: { query } object form\n');
        return result;
    }
    catch (objErr) {
        const isSignatureErr = /query.*(required|missing)|missing.*query|invalid.*param/i.test(objErr.message);
        if (!isSignatureErr)
            throw objErr;
        try {
            const result = await _ollamaClient.webSearch(query);
            _webSearchSignature = 'string';
            if (process.stdout?.write)
                process.stdout.write('[ollamaSearch/client] signature detected: plain string form\n');
            return result;
        }
        catch (strErr) {
            throw new Error(`webSearch() failed both signatures. object err: "${objErr.message}" | string err: "${strErr.message}"`);
        }
    }
}
function normalise(rawResults) {
    if (!Array.isArray(rawResults))
        return [];
    return rawResults.map(r => {
        let hostname = '';
        try {
            hostname = new URL(r.url || '').hostname;
        }
        catch { /* ignore */ }
        return {
            title: (r.title || '').trim(),
            link: (r.url || '').trim(),
            snippet: (r.content || '').trim(),
            cite: hostname
        };
    }).filter(r => r.link);
}
async function searchViaApiKey(query, maxResults, apiKey) {
    const clampedMax = Math.min(Math.max(1, maxResults), 10);
    const t0 = Date.now();
    if (process.stdout?.write)
        process.stdout.write(`[ollamaSearch/api-key] query="${query.slice(0, 60)}" max=${clampedMax}\n`);
    const response = await axios.post(ollama, { query, max_results: clampedMax }, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'deepthink-research-agent/1.0'
        },
        timeout: 20_000
    });
    const results = normalise(response.data?.results);
    if (process.stdout?.write)
        process.stdout.write(`[ollamaSearch/api-key] ${results.length} results in ${Date.now() - t0}ms\n`);
    return results;
}
async function searchViaClient(query) {
    const t0 = Date.now();
    if (process.stdout?.write)
        process.stdout.write(`[ollamaSearch/client] queued query="${query.slice(0, 60)}"\n`);
    const response = await _clientQueue.run(() => callWebSearch(query));
    const results = normalise(response?.results);
    if (process.stdout?.write)
        process.stdout.write(`[ollamaSearch/client] ${results.length} results in ${Date.now() - t0}ms\n`);
    return results;
}
export async function getOllamaSearchResults(query, maxResults = 5) {
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) {
        try {
            const results = await searchViaApiKey(query, maxResults, apiKey);
            if (results.length > 0)
                return results;
            if (process.stdout?.write)
                process.stdout.write('[ollamaSearch/api-key] 0 results — trying JS client\n');
        }
        catch (err) {
            if (process.stdout?.write)
                process.stdout.write(`[ollamaSearch/api-key] ${err.message} — trying JS client\n`);
        }
    }
    else if (process.stdout?.write) {
        process.stdout.write('[ollamaSearch] No OLLAMA_API_KEY — using JS client (no key required)\n');
    }
    try {
        return await searchViaClient(query);
    }
    catch (err) {
        throw new Error(`Both Ollama tiers failed. Last error: ${err.message}`);
    }
}
