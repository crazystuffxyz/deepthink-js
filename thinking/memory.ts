// thinking/memory.ts
import fs from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_PATH = path.join(os.homedir(), '.deepthink-js', 'memory.json');

function safeRead(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeWrite(file: string, data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    // memory writes are best-effort
  }
}

export interface Store {
  path: string;
  get<T = unknown>(key: string, fallback?: T): T | undefined;
  set(key: string, val: unknown): void;
  add(key: string, val: Record<string, unknown>): void;
  push(key: string, val: unknown): void;
  list<T = unknown>(key: string): T[];
  flush(): void;
  stats(): { keys: number; dirty: boolean; file: string };
}

export function makeStore(file: string = DEFAULT_PATH): Store {
  let state = safeRead(file);
  let dirty = false;
  let flushTimer: NodeJS.Timeout | null = null;

  function scheduleFlush(): void {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty) {
        safeWrite(file, state);
        dirty = false;
      }
    }, 200);
  }

  return {
    path: file,
    get<T = unknown>(key: string, fallback?: T): T | undefined {
      return (state[key] as T | undefined) ?? fallback;
    },
    set(key: string, val: unknown): void {
      state[key] = val;
      scheduleFlush();
    },
    add(key: string, val: Record<string, unknown>): void {
      const arr = Array.isArray(state[key]) ? (state[key] as unknown[]) : [];
      arr.push({ ...val, at: Date.now() });
      state[key] = arr.slice(-200);
      scheduleFlush();
    },
    push(key: string, val: unknown): void {
      const arr = Array.isArray(state[key]) ? (state[key] as unknown[]) : [];
      arr.push(val);
      state[key] = arr.slice(-200);
      scheduleFlush();
    },
    list<T = unknown>(key: string): T[] {
      return Array.isArray(state[key]) ? [...(state[key] as T[])] : [];
    },
    flush(): void {
      if (dirty) {
        safeWrite(file, state);
        dirty = false;
      }
    },
    stats(): { keys: number; dirty: boolean; file: string } {
      return { keys: Object.keys(state).length, dirty, file };
    }
  };
}

export function makeEphemeralStore(): Store {
  const state: Record<string, unknown> = {};
  return {
    path: '<ephemeral>',
    get: <T = unknown>(k: string, d?: T) => (state[k] as T | undefined) ?? d,
    set: (k: string, v: unknown) => {
      state[k] = v;
    },
    add: (k: string, v: Record<string, unknown>) => {
      const arr = Array.isArray(state[k]) ? (state[k] as unknown[]) : [];
      arr.push({ ...v, at: Date.now() });
      state[k] = arr.slice(-200);
    },
    push: (k: string, v: unknown) => {
      const arr = Array.isArray(state[k]) ? (state[k] as unknown[]) : [];
      arr.push(v);
      state[k] = arr.slice(-200);
    },
    list: <T = unknown>(k: string) => (Array.isArray(state[k]) ? [...(state[k] as T[])] : []),
    flush: () => {},
    stats: () => ({ keys: Object.keys(state).length, dirty: false, file: '<ephemeral>' })
  };
}
