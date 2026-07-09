// test_consistency.js — vote + sampleOnce
'use strict';

import { selfConsistency, vote, sampleOnce } from '../dist/thinking/consistency.js';
import { makeCalibrator } from '../dist/thinking/confidence.js';
import { keyFor, findRelevant } from '../dist/thinking/reflexion.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// vote
eq(vote(['hello', 'hello', 'world']), 'hello', 'majority hello');
eq(vote(['a', 'b']), 'a', 'tie goes to first');
eq(vote([]), '', 'empty');

// keyFor + findRelevant (no LLM, pure)
const k = keyFor('How many primes are below 100?');
ok(k.includes('primes'), 'key extracts primes');
const lessons = [{ key: 'primes below 100 count', lesson: 'use sieve' }];
const r = findRelevant(lessons, 'Count primes under 50', 3, 0.05);
ok(r.length >= 1, 'finds similar');

// confidence calibrator (pure)
const cal = makeCalibrator();
cal.record('integer', true);
cal.record('integer', false);
cal.record('integer', true);
eq(cal.rate('integer'), 2/3, 'rate int');
eq(cal.confidenceFor('integer') > 0.5, true, 'confidence blends toward data');
ok(typeof cal.snapshot() === 'object', 'snapshot returns obj');

console.log('consistency/reflexion/confidence (pure): ALL PASS');
