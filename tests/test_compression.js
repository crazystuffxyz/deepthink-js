// test_compression.js — totalTokens, approxTokens, truncateMiddle
'use strict';

import { totalTokens, approxTokens, truncateMiddle, compress } from '../dist/thinking/smartCompression.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// approxTokens
ok(approxTokens('hello world') > 0, 'approx > 0');
ok(approxTokens('a'.repeat(400)) > 80, 'approx scales');

// totalTokens
const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
ok(totalTokens(msgs) > 0, 'sum > 0');

// truncateMiddle keeps head + tail
const big = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));
const cut = truncateMiddle(big, 4, 8);
eq(cut.length, 4 + 1 + 8, 'truncate size');
ok(cut[4].content.includes('truncated'), 'middle marker');
eq(cut[0], big[0], 'first kept');
eq(cut.at(-1), big.at(-1), 'last kept');

// compress is a no-op when under budget
const small = [{ role: 'user', content: 'short' }];
const noOpCall = async () => { throw new Error('should not be called'); };
const r = await compress(noOpCall, small, { maxTokens: 10000 });
eq(r, small, 'compress noop under budget');

console.log('smartCompression (pure): ALL PASS');
