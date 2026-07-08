// test_evolvedMutate.js — pure unit tests for the mutation operators
'use strict';

import { mutate, OPERATORS } from '../thinking/evolvedMutate.js';
import { composePrompt, fingerprint, PATTERNS } from '../thinking/thinkingPatterns.js';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

async function fakeCallChat(msgs, stream, cb, opts) {
  return { content: 'You are a careful reasoner.\n\n1. x-step (A) — step x.\n   do x.\n\n2. y-step (B) — step y.\n   do y.' };
}

const parent = {
  id: 'c-0001',
  systemPrompt: composePrompt([PATTERNS[0], PATTERNS[5]], { tone: 'neutral' }),
  n: 2, names: [PATTERNS[0].name, PATTERNS[5].name], thinkers: [PATTERNS[0].thinker, PATTERNS[5].thinker], tone: 'neutral'
};

console.log('test_evolvedMutate');

await test('OPERATORS has 12+ entries', () => {
  if (OPERATORS.length < 12) throw new Error(`got ${OPERATORS.length}`);
});
await test('every operator has name/description/apply', () => {
  for (const op of OPERATORS) {
    if (!op.name) throw new Error('no name');
    if (!op.description) throw new Error(`${op.name}: no description`);
    if (typeof op.apply !== 'function') throw new Error(`${op.name}: no apply`);
  }
});
await test('mutate returns 1+ child', async () => {
  const r = await mutate(parent, { callChat: fakeCallChat, opts: {}, leaderboard: [] });
  if (!Array.isArray(r) || r.length < 1) throw new Error('no children');
  if (typeof r[0].systemPrompt !== 'string' || r[0].systemPrompt.length < 80) throw new Error('child too short');
});
await test('mutate child has parent and operator', async () => {
  const r = await mutate(parent, { callChat: fakeCallChat, opts: {}, leaderboard: [] });
  if (!r[0].parent) throw new Error('no parent');
  if (!r[0].operator) throw new Error('no operator');
});
await test('mutate child differs from parent', async () => {
  const r = await mutate(parent, { callChat: fakeCallChat, opts: {}, leaderboard: [] });
  if (r[0].systemPrompt === parent.systemPrompt) throw new Error('identical to parent');
});
await test('llmRewrite path produces non-trivial child when leaderboard set', async () => {
  // force the LLM path by stubbing random low
  const r = await mutate(parent, { callChat: fakeCallChat, opts: {}, leaderboard: [{ id: 'c-0000', score: 0.5, systemPrompt: 'foo' }, { id: 'c-0001', score: 0.4, systemPrompt: 'bar' }] }, () => 0.05);
  if (!r[0].systemPrompt) throw new Error('empty');
});

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
