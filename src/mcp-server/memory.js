// src/mcp-server/memory.js
// persistent namespaced key-value store with ttl + content-hash dedup.
// drives cross-session state, "remember this", and caches expensive llm results.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class MemoryStore {
  // ~256kb of json per value — enough for agent notes, not whole files
  static MAX_VALUE_BYTES = 256 * 1024;

  constructor(storePath) {
    this.path = storePath;
    this.data = { namespaces: {} };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.path)) {
        this.data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        if (!this.data.namespaces) this.data.namespaces = {};
      }
    } catch {
      this.data = { namespaces: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[MemoryStore] save failed:', err.message);
    }
  }

  _ns(ns) {
    if (!this.data.namespaces[ns]) this.data.namespaces[ns] = {};
    return this.data.namespaces[ns];
  }

  set(namespace, key, value, { ttlMs } = {}) {
    // hard cap so a 50mb dump can't freeze the event loop on every save
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch (e) {
      return { ok: false, error: 'value not serializable: ' + e.message };
    }
    if (raw && raw.length > MemoryStore.MAX_VALUE_BYTES) {
      return {
        ok: false,
        error: `value too large (${raw.length} bytes, max ${MemoryStore.MAX_VALUE_BYTES})`,
      };
    }
    const n = this._ns(namespace);
    n[key] = { value, ts: Date.now(), ttlMs: ttlMs || null, hash: _hash(value) };
    this._save();
    return { ok: true, key, namespace };
  }

  get(namespace, key) {
    const n = this._ns(namespace);
    const entry = n[key];
    if (!entry) return null;
    if (entry.ttlMs && Date.now() - entry.ts > entry.ttlMs) {
      delete n[key];
      this._save();
      return null;
    }
    return entry.value;
  }

  has(namespace, key) {
    return this.get(namespace, key) !== null;
  }

  delete(namespace, key) {
    const n = this._ns(namespace);
    const had = key in n;
    delete n[key];
    this._save();
    return { ok: had, key, namespace };
  }

  list(namespace) {
    const n = this._ns(namespace);
    return Object.keys(n).map((k) => ({
      key: k,
      ts: n[k].ts,
      ttlMs: n[k].ttlMs,
      hash: n[k].hash,
    }));
  }

  // substring "search" — real vector search would plug an embedding here.
  // good enough for short agent memory.
  search(namespace, query, limit = 10) {
    const n = this._ns(namespace);
    const q = String(query || '').toLowerCase();
    const out = [];
    for (const [k, entry] of Object.entries(n)) {
      const hay = (k + ' ' + JSON.stringify(entry.value)).toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({ key: k, value: entry.value, ts: entry.ts, score: q ? _score(hay, q) : 1 });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  // dedupe by content hash before storing
  setDedup(namespace, key, value, opts) {
    const h = _hash(value);
    const n = this._ns(namespace);
    for (const [k, entry] of Object.entries(n)) {
      if (entry.hash === h && k !== key) {
        return { ok: true, deduped: true, existingKey: k };
      }
    }
    return this.set(namespace, key, value, opts);
  }

  // sweep all expired entries
  gc() {
    let removed = 0;
    const now = Date.now();
    for (const ns of Object.keys(this.data.namespaces)) {
      for (const k of Object.keys(this.data.namespaces[ns])) {
        const e = this.data.namespaces[ns][k];
        if (e.ttlMs && now - e.ts > e.ttlMs) {
          delete this.data.namespaces[ns][k];
          removed++;
        }
      }
    }
    if (removed) this._save();
    return { ok: true, removed };
  }
}

function _hash(v) {
  // sha256 fingerprint — not security-critical, avoids future deprecation noise
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
}

function _score(hay, q) {
  if (!q) return 1;
  let s = 0;
  let i = 0;
  while ((i = hay.indexOf(q, i)) !== -1) {
    s++;
    i += q.length;
  }
  return s;
}

// thin tool wrappers. each validates required args, then delegates to ctx.memory.
function missing(args, ...keys) {
  const absent = keys.filter((k) => args[k] === undefined);
  if (absent.length) return `missing required arg(s): ${absent.join(', ')}`;
  return null;
}

async function deepthink_memory_set(args, ctx) {
  const err = missing(args, 'namespace', 'key', 'value');
  if (err) return { ok: false, error: err };
  if (args.dedup) return ctx.memory.setDedup(args.namespace, args.key, args.value, { ttlMs: args.ttlMs });
  return ctx.memory.set(args.namespace, args.key, args.value, { ttlMs: args.ttlMs });
}

async function deepthink_memory_get(args, ctx) {
  const err = missing(args, 'namespace', 'key');
  if (err) return { ok: false, error: err };
  return { ok: true, value: ctx.memory.get(args.namespace, args.key) };
}

async function deepthink_memory_search(args, ctx) {
  const err = missing(args, 'namespace');
  if (err) return { ok: false, error: err };
  return { ok: true, results: ctx.memory.search(args.namespace, args.query, args.limit || 10) };
}

async function deepthink_memory_list(args, ctx) {
  const err = missing(args, 'namespace');
  if (err) return { ok: false, error: err };
  return { ok: true, keys: ctx.memory.list(args.namespace) };
}

async function deepthink_memory_delete(args, ctx) {
  const err = missing(args, 'namespace', 'key');
  if (err) return { ok: false, error: err };
  return ctx.memory.delete(args.namespace, args.key);
}

async function deepthink_memory_gc(args, ctx) {
  return ctx.memory.gc();
}

export default {
  deepthink_memory_set,
  deepthink_memory_get,
  deepthink_memory_search,
  deepthink_memory_list,
  deepthink_memory_delete,
  deepthink_memory_gc,
};
