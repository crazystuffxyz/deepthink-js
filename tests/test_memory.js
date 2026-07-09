// test_memory.js — persistent + ephemeral stores
'use strict';

import { makeStore, makeEphemeralStore } from '../dist/thinking/memory.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ephemeral store
const s = makeEphemeralStore();
eq(s.get('x', 5), 5, 'default fallback');
s.set('x', 1);
eq(s.get('x'), 1, 'set/get');
s.push('list', 'a');
s.push('list', 'b');
eq(s.list('list'), ['a', 'b'], 'push/list');
s.add('events', { kind: 'a' });
s.add('events', { kind: 'b' });
eq(s.list('events').length, 2, 'add/list with timestamps');
ok(typeof s.flush() === 'undefined', 'flush ok');

// persistent store: write, read, mutate
const tmpFile = path.join(os.tmpdir(), `dt_test_mem_${Date.now()}.json`);
try {
  const p1 = makeStore(tmpFile);
  p1.set('counter', 0);
  p1.set('counter', 1);
  p1.flush();
  const p2 = makeStore(tmpFile);
  eq(p2.get('counter'), 1, 'persistent readback');
  p2.set('counter', 99);
  p2.flush();
  const p3 = makeStore(tmpFile);
  eq(p3.get('counter'), 99, 'persistent write survived');
} finally {
  try { fs.unlinkSync(tmpFile); } catch {}
}

console.log('memory: ALL PASS');
