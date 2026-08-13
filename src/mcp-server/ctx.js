// src/mcp-server/ctx.js
// one shared runtime context for the whole MCP server. tools get `ctx` and
// read/write the bits they need instead of each building their own services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeEngine, destroy as destroyEngines } from './engine.js';
import { MemoryStore } from './memory.js';
import { getPool } from './worker.js';

// bounded ring both the logger and get_event_log read from
const RING_MAX = 2000;
const eventLog = [];
function pushLog(entry) {
  eventLog.push(entry);
  if (eventLog.length > RING_MAX) eventLog.splice(0, eventLog.length - RING_MAX);
}

// rollback log: every mutating file op records enough to undo it
const tx = {
  ops: [],
  record(op) {
    this.ops.push({ ts: Date.now(), ...op });
    if (this.ops.length > 1000) this.ops.splice(0, this.ops.length - 1000);
  },
  list() {
    return this.ops.map((o) => ({ ...o }));
  },
  async rollback() {
    const undone = [];
    for (const op of [...this.ops].reverse()) {
      try {
        if (op.kind === 'write') {
          if (op.prev) fs.writeFileSync(op.path, op.prev);
          else fs.rmSync(op.path, { force: true });
        } else if (op.kind === 'mkdir') {
          fs.rmSync(op.path, { recursive: true, force: true });
        } else if (op.kind === 'delete') {
          if (op.prev) fs.writeFileSync(op.path, op.prev);
        }
        undone.push(op);
      } catch {
        // best effort — leave the op so the caller can retry manually
      }
    }
    this.ops = [];
    return undone;
  },
};

const cancel = { flag: false, reset() { this.flag = false; }, set() { this.flag = true; } };

let shared = null;

export function createContext(opts = {}) {
  if (shared) return shared;

  // persistent memory lives in the user data dir unless told otherwise
  const memPath =
    opts.memoryPath ||
    path.join(process.env.APPDATA || os.homedir(), 'deepthink', 'memory', 'mcp-memory.json');

  const ctx = {
    engine: makeEngine(),
    memory: new MemoryStore(memPath),
    pool: getPool(),
    eventLog,
    pushLog,
    tx,
    cancel,
    config: {
      defaultModel: opts.defaultModel || process.env.DEEPTHINK_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b-cloud',
      ollamaHost: opts.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434',
    },
    // set once the registry is assembled (index.js)
    run: async (name, args) => {
      throw new Error(`tool dispatch not wired yet: ${name}`);
    },
    destroy() {
      ctx.pool.close();
      destroyEngines();
    },
  };
  shared = ctx;
  return ctx;
}

export function destroyContext() {
  shared = null;
}
