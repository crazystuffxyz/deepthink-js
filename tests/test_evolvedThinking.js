// test_evolvedThinking.js — pure unit tests for the evolution loop (no LLM calls)
'use strict';

import { seedPopulation, evalCandidate, evolvePrompts, applyEvolvedPrompt, applyEvolvedPromptWithTrace, splitTrace, loadBest } from '../thinking/evolvedThinking.js';
import { BENCH, OOD_BENCH } from '../thinking/benchmarkSet.js';
import { PATTERNS, composePrompt, fingerprint } from '../thinking/thinkingPatterns.js';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

console.log('test_evolvedThinking');

await test('seedPopulation returns N candidates', () => {
  const pop = seedPopulation(8);
  if (pop.length !== 8) throw new Error(`got ${pop.length}`);
  for (const c of pop) {
    if (!c.id) throw new Error('no id');
    if (!c.systemPrompt) throw new Error('no prompt');
    if (!c.operator) throw new Error('no operator');
  }
});
await test('seedPopulation has mix of seeds', () => {
  const pop = seedPopulation(15);
  const ops = new Set(pop.map(c => c.operator));
  if (ops.size < 3) throw new Error('low operator diversity');
});
await test('seedPopulation is deterministic with seeded rng', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const a = seedPopulation(8, rng).map(c => c.systemPrompt.slice(0, 50));
  seed = 7;
  const b = seedPopulation(8, rng).map(c => c.systemPrompt.slice(0, 50));
  if (a.join('|') !== b.join('|')) throw new Error('not deterministic');
});
await test('applyEvolvedPrompt runs through callChat', async () => {
  const calls = [];
  const fakeChat = async (msgs) => { calls.push(msgs); return { content: 'response' }; };
  const r = await applyEvolvedPrompt(fakeChat, 'do x', 'what?', {});
  if (r !== 'response') throw new Error('bad');
  if (calls.length !== 1) throw new Error(`calls: ${calls.length}`);
  if (calls[0][0].content !== 'do x') throw new Error('sys prompt wrong');
});
await test('loadBest throws on bad path', () => {
  let threw = false;
  try { loadBest('/nonexistent/dir'); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});
await test('splitTrace extracts think block from response', () => {
  const t = splitTrace('<thinking>\nlet me think. actually...\n</thinking>\n\nThe answer is 42.');
  if (t.hadThinkBlock !== true) throw new Error('no flag');
  if (!t.think.includes('let me think')) throw new Error('think missing');
  if (!t.answer.includes('42')) throw new Error('answer missing');
});
await test('splitTrace handles no think block', () => {
  const t = splitTrace('Just a plain answer.');
  if (t.hadThinkBlock !== false) throw new Error('flag wrong');
  if (t.think !== '') throw new Error('think should be empty');
  if (!t.answer.includes('plain')) throw new Error('answer missing');
});
await test('applyEvolvedPromptWithTrace returns split', async () => {
  const fakeChat = async () => ({ content: '<thinking>x</thinking>\n\nresult' });
  const r = await applyEvolvedPromptWithTrace(fakeChat, 's', 'q');
  if (r.think !== 'x' || r.answer !== 'result') throw new Error(`bad split: ${JSON.stringify(r)}`);
});
await test('OOD_BENCH exists with 5+ held-out items', () => {
  if (!OOD_BENCH || OOD_BENCH.length < 5) throw new Error(`got ${OOD_BENCH?.length}`);
  for (const o of OOD_BENCH) {
    if (!o.id || !o.prompt || !o.kind) throw new Error('missing field on ood item');
  }
});
await test('OOD items do not overlap with BENCH ids', () => {
  const ids = new Set(BENCH.map(b => b.id));
  for (const o of OOD_BENCH) if (ids.has(o.id)) throw new Error(`overlap: ${o.id}`);
});

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
