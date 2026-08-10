// thinking/memory.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
export const DEFAULT_PATH = path.join(os.homedir(), '.deepthink-js', 'memory.json');
function safeRead(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function safeWrite(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }
    catch {
        // memory writes are best-effort
    }
}
export function makeStore(file = DEFAULT_PATH) {
    let state = safeRead(file);
    let dirty = false;
    let flushTimer = null;
    function scheduleFlush() {
        dirty = true;
        if (flushTimer)
            return;
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
        get(key, fallback) {
            return state[key] ?? fallback;
        },
        set(key, val) {
            state[key] = val;
            scheduleFlush();
        },
        add(key, val) {
            const arr = Array.isArray(state[key]) ? state[key] : [];
            arr.push({ ...val, at: Date.now() });
            state[key] = arr.slice(-200);
            scheduleFlush();
        },
        push(key, val) {
            const arr = Array.isArray(state[key]) ? state[key] : [];
            arr.push(val);
            state[key] = arr.slice(-200);
            scheduleFlush();
        },
        list(key) {
            return Array.isArray(state[key]) ? [...state[key]] : [];
        },
        flush() {
            if (dirty) {
                safeWrite(file, state);
                dirty = false;
            }
        },
        stats() {
            return { keys: Object.keys(state).length, dirty, file };
        }
    };
}
export function makeEphemeralStore() {
    const state = {};
    return {
        path: '<ephemeral>',
        get: (k, d) => state[k] ?? d,
        set: (k, v) => {
            state[k] = v;
        },
        add: (k, v) => {
            const arr = Array.isArray(state[k]) ? state[k] : [];
            arr.push({ ...v, at: Date.now() });
            state[k] = arr.slice(-200);
        },
        push: (k, v) => {
            const arr = Array.isArray(state[k]) ? state[k] : [];
            arr.push(v);
            state[k] = arr.slice(-200);
        },
        list: (k) => (Array.isArray(state[k]) ? [...state[k]] : []),
        flush: () => { },
        stats: () => ({ keys: Object.keys(state).length, dirty: false, file: '<ephemeral>' })
    };
}
