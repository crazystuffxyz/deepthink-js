// test_evolvedThinking.js — pure unit tests for the evolution loop (no LLM calls)
'use strict';

import { seedPopulation, evalCandidate, evolvePrompts, applyEvolvedPrompt, loadBest } from '../thinking/evolvedThinking.js';
import { BENCH } from '../thinking/benchmarkSet.js';
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

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
