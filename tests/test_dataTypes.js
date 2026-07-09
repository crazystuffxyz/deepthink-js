// test_dataTypes.js — pure-function tests, no LLM needed
'use strict';

import {
  stripThinkBlocks, stripCodeFences, parseDataType, extractJSON,
  isPlainObject, isChatMessage, cloneMessage, messagesToText,
  normalizeInputToMessages, createDefaultSystemPrompt
} from '../dist/thinking/dataTypes.js';

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function ok(cond, label) {
  if (!cond) throw new Error(`${label}: expected truthy, got ${cond}`);
}

// stripThinkBlocks
eq(stripThinkBlocks('foo<think>secret</think>bar'), 'foobar', 'strip simple think');
eq(stripThinkBlocks('foo<think x="1">a</think>bar'), 'foobar', 'strip attrs');
eq(stripThinkBlocks('a<think><b>nested</b></think>c'), 'ac', 'strip with content');
eq(stripThinkBlocks(null), '', 'null safe');
eq(stripThinkBlocks(123), '123', 'number safe');

// stripCodeFences
eq(stripCodeFences('```js\nfoo\n```'), 'foo', 'strip fence');
eq(stripCodeFences('```\nbar\n```'), 'bar', 'strip bare fence');
eq(stripCodeFences('hello'), 'hello', 'no-op');

// parseDataType
eq(parseDataType('answer: 42', 'integer'), 42, 'integer parse');
eq(parseDataType('the 3.14 is pi', 'double'), 3.14, 'double parse');
eq(parseDataType('YES', 'boolean'), true, 'boolean YES');
eq(parseDataType('NO', 'boolean'), false, 'boolean NO');
eq(parseDataType('the answer is true', 'boolean'), true, 'boolean true mid');
eq(parseDataType('hello world', 'string'), 'hello world', 'string passthrough');
eq(parseDataType('final answer is 7', 'integer'), 7, 'last int wins');
eq(parseDataType('no digits here', 'integer'), 0, 'int fallback 0');

// extractJSON
eq(extractJSON('prefix {"a":1,"b":[2,3]} suffix'), { a: 1, b: [2, 3] }, 'extract nested');

// isPlainObject / isChatMessage
ok(isPlainObject({}), 'plain object yes');
ok(!isPlainObject([]), 'array no');
ok(!isPlainObject(null), 'null no');
ok(isChatMessage({ role: 'user', content: 'hi' }), 'chat msg yes');
ok(!isChatMessage({ content: 'hi' }), 'no role no');

// cloneMessage
const orig = { role: 'user', content: 'x', images: ['a', 'b'] };
const c = cloneMessage(orig);
ok(c !== orig, 'clone is new ref');
ok(c.images !== orig.images, 'images ref new');
eq(c.images, ['a', 'b'], 'images copied');

// messagesToText
eq(messagesToText('hi'), 'hi', 'string passthrough');
eq(messagesToText([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]),
   '[USER 1]\na\n\n[ASSISTANT 2]\nb', 'array of msgs');
eq(messagesToText({ a: 1 }), '{\n  "a": 1\n}', 'object stringify');

// normalizeInputToMessages
const m1 = normalizeInputToMessages('hello');
eq(m1.length, 1, 'string -> 1 msg');
eq(m1[0].role, 'user', 'string role user');
const m2 = normalizeInputToMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
eq(m2.length, 2, 'chat array kept');
const m3 = normalizeInputToMessages({ role: 'system', content: 'sys' });
eq(m3[0].role, 'system', 'obj with role');

// createDefaultSystemPrompt
ok(createDefaultSystemPrompt('string', 0).length > 0, 'default sys non-empty');
ok(createDefaultSystemPrompt('integer', 2).includes('integer'), 'integer mentioned');

console.log('dataTypes: ALL PASS');
