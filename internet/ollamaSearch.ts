// internet/ollamaSearch.ts
// Ollama Web Search (api-key tier + JS-client tier).
import axios from './axios.js';
import { Ollama } from 'ollama';

const ollama = 'https://ollama.com/api/web_search';
const ollama1 = 3;
// same timeout-fetch trick as providers/index.ts — a hung search must die
function makeTimeoutFetch(timeoutMs: number): typeof fetch {
  return ((input: any, init: any) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }) as typeof fetch;
}
const _ollamaClient = new Ollama({ fetch: makeTimeoutFetch(Number(process.env.OLLAMA_TIMEOUT_MS) || 60_000) });

class Concurrency {
  _limit: number;
  _running: number;
  _queue: Array<() => void>;
  constructor(limit: number) {
    this._limit = limit;
    this._running = 0;
    this._queue = [];
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this._running++;
        try { resolve(await task()); }
        catch (e) { reject(e); }
        finally {
          this._running--;
          if (this._queue.length) this._queue.shift()!();
        }
      };
      this._running < this._limit ? execute() : this._queue.push(execute);
    });
  }
}

const _clientQueue = new Concurrency(ollama1);
let _webSearchSignature: string | null = null;
// probe once: the local ollama server often has no web_search endpoint (404)
// or needs auth (401) — paying that failure on EVERY query is wasted latency.
// after the first probe we know whether the client tier is worth trying.
let _clientTierUsable: boolean | null = null;

async function probeClientTier(): Promise<boolean> {
  if (_clientTierUsable !== null) return _clientTierUsable;
  try {
    const r = await searchViaClient('probe');
    _clientTierUsable = true;
    if (process.stdout?.write) process.stdout.write('[ollamaSearch] client tier probe OK\n');
    return true;
  } catch (err) {
    _clientTierUsable = false;
    // err can be undefined (a rejected promise with no value) — never let
    // the probe's own error handling crash the search chain
    const why = String((err as Error)?.message ?? err ?? 'unknown').slice(0, 60);
    if (process.stdout?.write) process.stdout.write(`[ollamaSearch] client tier probe FAILED (${why}) — skipping client tier this session\n`);
    return false;
  }
}

async function callWebSearch(query: string): Promise<unknown> {
  if (typeof (_ollamaClient as any).webSearch !== 'function') {
    throw new Error('ollama package does not expose webSearch(). Run: npm install ollama@latest');
  }
  if (_webSearchSignature === 'object') return (_ollamaClient as any).webSearch({ query });
  if (_webSearchSignature === 'string') return (_ollamaClient as any).webSearch(query);
  try {
    const result = await (_ollamaClient as any).webSearch({ query });
    _webSearchSignature = 'object';
    if (process.stdout?.write) process.stdout.write('[ollamaSearch/client] signature detected: { query } object form\n');
    return result;
  } catch (objErr) {
    const isSignatureErr = /query.*(required|missing)|missing.*query|invalid.*param/i.test((objErr as Error).message);
    if (!isSignatureErr) throw objErr;
    try {
      const result = await (_ollamaClient as any).webSearch(query);
      _webSearchSignature = 'string';
      if (process.stdout?.write) process.stdout.write('[ollamaSearch/client] signature detected: plain string form\n');
      return result;
    } catch (strErr) {
      throw new Error(`webSearch() failed both signatures. object err: "${(objErr as Error).message}" | string err: "${(strErr as Error).message}"`);
    }
  }
}

function normalise(rawResults: unknown): Array<{ title: string; link: string; snippet: string; cite: string }> {
  if (!Array.isArray(rawResults)) return [];
  return rawResults.map(r => {
    let hostname = '';
    try { hostname = new URL((r as any).url || '').hostname; } catch { /* ignore */ }
    return {
      title: ((r as any).title || '').trim(),
      link: ((r as any).url || '').trim(),
      snippet: ((r as any).content || '').trim(),
      cite: hostname
    };
  }).filter(r => r.link);
}

async function searchViaApiKey(query: string, maxResults: number, apiKey: string): Promise<Array<{ title: string; link: string; snippet: string; cite: string }>> {
  const clampedMax = Math.min(Math.max(1, maxResults), 10);
  const t0 = Date.now();
  if (process.stdout?.write) process.stdout.write(`[ollamaSearch/api-key] query="${query.slice(0, 60)}" max=${clampedMax}\n`);
  const response = await axios.post(ollama, { query, max_results: clampedMax }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'deepthink-research-agent/1.0'
    },
    timeout: 20_000
  });
  const results = normalise((response as any).data?.results);
  if (process.stdout?.write) process.stdout.write(`[ollamaSearch/api-key] ${results.length} results in ${Date.now() - t0}ms\n`);
  return results;
}

async function searchViaClient(query: string): Promise<Array<{ title: string; link: string; snippet: string; cite: string }>> {
  const t0 = Date.now();
  if (process.stdout?.write) process.stdout.write(`[ollamaSearch/client] queued query="${query.slice(0, 60)}"\n`);
  const response = await _clientQueue.run(() => callWebSearch(query));
  const results = normalise((response as any)?.results);
  if (process.stdout?.write) process.stdout.write(`[ollamaSearch/client] ${results.length} results in ${Date.now() - t0}ms\n`);
  return results;
}

export async function getOllamaSearchResults(query: string, maxResults = 5): Promise<Array<{ title: string; link: string; snippet: string; cite: string }>> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (apiKey) {
    try {
      const results = await searchViaApiKey(query, maxResults, apiKey);
      if (results.length > 0) return results;
      if (process.stdout?.write) process.stdout.write('[ollamaSearch/api-key] 0 results — trying JS client\n');
    } catch (err) {
      if (process.stdout?.write) process.stdout.write(`[ollamaSearch/api-key] ${(err as Error).message} — trying JS client\n`);
    }
  } else if (process.stdout?.write) {
    process.stdout.write('[ollamaSearch] No OLLAMA_API_KEY — checking JS client tier\n');
  }
  if (await probeClientTier()) {
    try {
      return await searchViaClient(query);
    } catch (err) {
      throw new Error(`Ollama client tier failed: ${(err as Error).message}`);
    }
  }
  throw new Error('Ollama search unavailable (no API key, client tier unusable)');
}
