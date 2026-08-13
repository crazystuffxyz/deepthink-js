// src/mcp-server/worker.js
// persistent pool of node subprocesses for running agent JS snippets.
// spawning a node process per eval costs ~100-300ms; keeping 2-4 warm
// workers alive drops that to ~1ms. workers are disposable — a crash or
// timeout just kills + respawns one, the server never notices.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker-child.js', import.meta.url));
const DEFAULT_SIZE = Math.max(1, Math.min(4, os.cpus().length - 1 || 2));
const DEFAULT_TIMEOUT = 15000;

export class JsWorkerPool {
  constructor({ size = DEFAULT_SIZE, timeout = DEFAULT_TIMEOUT } = {}) {
    this.size = size;
    this.timeout = timeout;
    this.workers = []; // { proc, busy, pending: Map<id, {resolve, reject, timer}> }
    this._nextId = 1;
    this._closed = false;
  }

  _spawn() {
    const proc = spawn(process.execPath, [WORKER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      // minimal env — the worker needs nothing, and this keeps api keys
      // out of reach even if sandboxed code finds a way to read env
      env: { NODE_OPTIONS: '' },
    });
    const w = { proc, busy: false, pending: new Map() };
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this._onLine(w, line);
      }
    });
    proc.on('exit', () => {
      // fail anything still waiting, then let the pool respawn on demand
      for (const p of w.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('js worker exited unexpectedly'));
      }
      w.pending.clear();
      w.dead = true;
    });
    proc.on('error', () => {
      w.dead = true;
    });
    return w;
  }

  _onLine(w, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // garbage line — ignore
    }
    const p = w.pending.get(msg.id);
    if (!p) return;
    w.pending.delete(msg.id);
    clearTimeout(p.timer);
    w.busy = false;
    if (msg.ok) p.resolve({ ok: true, result: msg.result, state: msg.state, output: msg.output });
    else p.resolve({ ok: false, error: msg.error, stack: msg.stack, state: msg.state, output: msg.output });
  }

  // run code with `state` in scope. resolves {ok, result, state, error}.
  async eval(code, state = {}, { timeout = this.timeout } = {}) {
    if (this._closed) throw new Error('worker pool closed');
    const id = this._nextId++;
    const payload = JSON.stringify({ id, code, state }) + '\n';
    const w = await this._acquire();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // hung — mark dead, kill, fail. next _acquire sees dead=true and
        // respawns instead of reusing a dying worker.
        w.pending.delete(id);
        w.busy = false;
        w.dead = true;
        try {
          w.proc.kill('SIGKILL');
        } catch {}
        reject(new Error(`js eval timed out after ${timeout}ms`));
      }, timeout);
      w.pending.set(id, { resolve, reject, timer });
      w.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          w.pending.delete(id);
          w.busy = false;
          reject(new Error(`js worker write failed: ${err.message}`));
        }
      });
    });
  }

  _acquire() {
    // reuse a free live worker
    for (const w of this.workers) {
      if (!w.dead && !w.busy) {
        w.busy = true;
        return w;
      }
    }
    // respawn dead slots, then grow up to size
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workers[i].dead) {
        const w = this._spawn();
        this.workers[i] = w;
        w.busy = true;
        return w;
      }
    }
    if (this.workers.length < this.size) {
      const w = this._spawn();
      this.workers.push(w);
      w.busy = true;
      return w;
    }
    // all busy — wait for the first free one
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        for (const w of this.workers) {
          if (!w.dead && !w.busy) {
            clearInterval(poll);
            w.busy = true;
            resolve(w);
            return;
          }
        }
      }, 5);
    });
  }

  close() {
    this._closed = true;
    for (const w of this.workers) {
      try {
        w.proc.kill('SIGTERM');
      } catch {}
    }
    this.workers = [];
  }
}

// singleton — the whole server shares one pool
let shared = null;
export function getPool(opts) {
  if (!shared) shared = new JsWorkerPool(opts);
  return shared;
}

// tool entry — run args.code with args.state in scope, ship the mutated
// state back so the caller can resume a retry
export default {
  deepthink_js_execute: async (args, ctx) => {
    const out = await ctx.pool.eval(args.code, args.state || {}, { timeout: args.timeout });
    return { ok: out.ok, result: out.result, state: out.state, error: out.error, output: out.output };
  },
};
