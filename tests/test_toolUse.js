// test_toolUse.js — parseToolCall, describeTools (pure)
'use strict';

import { parseToolCall, describeTools, DEFAULT_TOOLS } from '../thinking/toolUse.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// parseToolCall: bare JSON
const c1 = parseToolCall('thinking... {"tool":"js_eval","params":{"code":"console.log(1)"}} end');
eq(c1.tool, 'js_eval', 'bare JSON tool');
eq(c1.params.code, 'console.log(1)', 'bare JSON params');

// parseToolCall: fenced JSON
const c2 = parseToolCall('response:\n```json\n{"tool":"finish","params":{"answer":"42"}}\n```');
eq(c2.tool, 'finish', 'fenced tool');
eq(c2.params.answer, '42', 'fenced params');

// parseToolCall: no tool
const c3 = parseToolCall('just plain text without any json');
eq(c3, null, 'no tool -> null');

// describeTools
const desc = describeTools(DEFAULT_TOOLS);
ok(desc.includes('js_eval'), 'desc includes js_eval');
ok(desc.includes('finish'), 'desc includes finish');

console.log('toolUse (pure): ALL PASS');
