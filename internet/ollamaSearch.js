import axios from './axios.js';
import { Ollama } from 'ollama';
const ollama = 'https://ollama.com/api/web_search';
const ollama1 = 3;
const _ollamaClient = new Ollama();
class Concurrency {
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
        } catch (e) {
          reject(e);
        } finally {
          this._running--;
          if (this._queue.length) this._queue.shift()();
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
  if (_webSearchSignature === 'object') return _ollamaClient.webSearch({
    query
  });
  if (_webSearchSignature === 'string') return _ollamaClient.webSearch(query);
  try {
    const result = await _ollamaClient.webSearch({
      query
    });
    _webSearchSignature = 'object';
    console.debug('[ollamaSearch/client] signature detected: { query } object form');
    return result;
  } catch (objErr) {
    const isSignatureErr = /query.*(required|missing)|missing.*query|invalid.*param/i.test(objErr.message);
    if (!isSignatureErr) throw objErr;
    try {
      const result = await _ollamaClient.webSearch(query);
      _webSearchSignature = 'string';
      console.debug('[ollamaSearch/client] signature detected: plain string form');
      return result;
    } catch (strErr) {
      throw new Error(`webSearch() failed both signatures. ` + `object err: "${objErr.message}" | string err: "${strErr.message}"`);
    }
  }
}

function normalise(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  return rawResults.map(r => {
    let hostname = '';
    try {
      hostname = new URL(r.url || '').hostname;
    } catch {}
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
  console.debug(`[ollamaSearch/api-key] query="${query.slice(0, 60)}" max=${clampedMax}`);
  const response = await axios.post(ollama, {
    query,
    max_results: clampedMax
  }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'deepthink-research-agent/1.0'
    },
    timeout: 20_000
  });
  const results = normalise(response.data?.results);
  console.debug(`[ollamaSearch/api-key] ${results.length} results in ${Date.now() - t0}ms`);
  return results;
}
async function searchViaClient(query) {
  const t0 = Date.now();
  console.debug(`[ollamaSearch/client] queued query="${query.slice(0, 60)}"`);
  const response = await _clientQueue.run(() => callWebSearch(query));
  const results = normalise(response?.results);
  console.debug(`[ollamaSearch/client] ${results.length} results in ${Date.now() - t0}ms`);
  return results;
}
export async function getOllamaSearchResults(query, maxResults = 5) {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    try {
      const results = await searchViaApiKey(query, maxResults, apiKey);
      if (results.length > 0) return results;
      console.warn('[ollamaSearch/api-key] 0 results — trying JS client');
    } catch (err) {
      console.warn(`[ollamaSearch/api-key] ${err.message} — trying JS client`);
    }
  } else {
    console.debug('[ollamaSearch] No OLLAMA_API_KEY — using JS client (no key required)');
  }
  try {
    return await searchViaClient(query);
  } catch (err) {
    throw new Error(`Both Ollama tiers failed. Last error: ${err.message}`);
  }
}