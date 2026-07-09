// test_evolvedScoring.js — pure unit tests for the scorer
'use strict';

import { BENCH, numericScore } from '../dist/thinking/benchmarkSet.js';
import { scoreOne, scoreAgainstBench, extractAllNumbers, extractProbability, multiNumberScore } from '../dist/thinking/evolvedScoring.js';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

async function fakeCallChat(msgs, stream, cb, opts) {
  return { content: '{"correctness": 0.8, "reasoningDepth": 0.6, "structure": 0.7, "falsifiability": 0.5, "selfCorrection": 0.4}' };
}

console.log('test_evolvedScoring');

await test('numericScore exact hit', () => {
  const s = numericScore(132, 132, 0.05);
  if (s !== 1) throw new Error(`expected 1, got ${s}`);
});
await test('numericScore within tolerance', () => {
  const s = numericScore(131, 132, 0.05);
  if (s < 0.9) throw new Error(`expected ~1, got ${s}`);
});
await test('numericScore way off', () => {
  const s = numericScore(50, 132, 0.05);
  if (s !== 0) throw new Error(`expected 0, got ${s}`);
});
await test('numericScore handles NaN', () => {
  const s = numericScore(NaN, 132, 0.05);
  if (s !== 0) throw new Error(`expected 0, got ${s}`);
});
await test('BENCH has 10 items', () => {
  if (BENCH.length !== 10) throw new Error(`got ${BENCH.length}`);
});
await test('every BENCH item has id/kind/prompt', () => {
  for (const b of BENCH) {
    if (!b.id) throw new Error('missing id');
    if (!b.kind) throw new Error(`${b.id}: missing kind`);
    if (!b.prompt) throw new Error(`${b.id}: missing prompt`);
  }
});
await test('scoreOne: math item with right answer', async () => {
  const item = BENCH.find(b => b.id === 'b05-gravity');
  const r = await scoreOne(fakeCallChat, 'The answer is 2.0 g', item, {});
  if (r.score < 0.9) throw new Error(`expected high, got ${r.score}`);
});
await test('scoreOne: math item with wrong answer', async () => {
  const item = BENCH.find(b => b.id === 'b05-gravity');
  const r = await scoreOne(fakeCallChat, 'The answer is 5 g', item, {});
  if (r.score > 0.1) throw new Error(`expected low, got ${r.score}`);
});
await test('scoreOne: logic item, indeterminate with counterexample', async () => {
  const item = BENCH.find(b => b.id === 'b03-zorp-glop');
  const r = await scoreOne(fakeCallChat, 'INDETERMINATE — counterexample: all Zorps are Fims, but no Fim is a Glop. So zero Zorps are Glops.', item, {});
  if (r.score < 0.7) throw new Error(`expected high, got ${r.score}`);
});
await test('scoreOne: logic item, wrong conclusion', async () => {
  const item = BENCH.find(b => b.id === 'b03-zorp-glop');
  const r = await scoreOne(fakeCallChat, 'YES, some Zorps are Glops.', item, {});
  if (r.score > 0.5) throw new Error(`expected low, got ${r.score}`);
});
await test('scoreOne: deduction with right answer', async () => {
  const item = BENCH.find(b => b.id === 'b07-einstein');
  const r = await scoreOne(fakeCallChat, 'The German owns the fish.', item, {});
  if (r.score < 0.9) throw new Error(`expected high, got ${r.score}`);
});
await test('scoreOne: rubric-based ethics item (via fake judge)', async () => {
  const item = BENCH.find(b => b.id === 'b10-ethics');
  const r = await scoreOne(fakeCallChat, 'A position and a steelman.', item, {});
  if (typeof r.score !== 'number') throw new Error('no score');
});
await test('scoreAgainstBench handles missing outputs', async () => {
  const bench = BENCH.slice(0, 2);
  const outputs = { 'b01-train-meet': '16:12' };
  const r = await scoreAgainstBench(fakeCallChat, outputs, bench, {});
  if (r.aggregate < 0 || r.aggregate > 1) throw new Error(`out of range: ${r.aggregate}`);
  if (r.detail.length !== 2) throw new Error(`detail length: ${r.detail.length}`);
});
await test('think-bonus rewards <thinking> block on math item', async () => {
  const item = BENCH.find(b => b.id === 'b05-gravity');
  const noThink = await scoreOne(fakeCallChat, 'The answer is 2.0 g', item, {});
  const withThink = await scoreOne(fakeCallChat,
    '<thinking>\nLet me think. Actually, F=ma, m=1kg, a=2 m/s^2, so F=2N, weight=2*9.8=19.6? wait, I misread. The answer is 2.0 g, with edge case consideration.\n</thinking>\n\nThe answer is 2.0 g.',
    item, {});
  if (withThink.weighted <= noThink.weighted) throw new Error(`think should boost: no=${noThink.weighted} with=${withThink.weighted}`);
  if (!withThink.components.thinkBonus) throw new Error('no thinkBonus component');
});
await test('math with time+distance reference scores both', async () => {
  const item = BENCH.find(b => b.id === 'b01-train-meet');
  if (!item.reference.time || item.reference.distanceFromX == null) throw new Error('test setup wrong');
  const good = await scoreOne(fakeCallChat, 'The trains meet at 16:12, 132 km from X.', item, {});
  if (good.components.timeOk !== 1) throw new Error(`timeOk: ${good.components.timeOk}`);
  if (good.components.distOk !== 1) throw new Error(`distOk: ${good.components.distOk}`);
  if (good.score < 0.9) throw new Error(`combo: ${good.score}`);
  const bad = await scoreOne(fakeCallChat, 'The trains meet at 17:30, 200 km from X.', item, {});
  if (bad.score > 0.2) throw new Error(`bad combo too high: ${bad.score}`);
  const partial = await scoreOne(fakeCallChat, 'The trains meet at 16:12.', item, {});
  if (partial.components.timeOk !== 1) throw new Error('partial timeOk');
  if (partial.score > 0.6) throw new Error(`partial too high: ${partial.score}`);
});
await test('extractAllNumbers pulls every number in order', () => {
  const nums = extractAllNumbers('A owes 11.5625, B owes 16.5625, C owes 16.875');
  if (nums.length !== 3) throw new Error(`got ${nums.length}: ${nums}`);
  if (nums[0] !== 11.5625) throw new Error(`first: ${nums[0]}`);
  if (nums[2] !== 16.875) throw new Error(`last: ${nums[2]}`);
});
await test('extractProbability handles percent and decimal', () => {
  if (extractProbability('about 27.8%', 0.278) !== 0.278) throw new Error('percent');
  if (extractProbability('0.278', 0.278) !== 0.278) throw new Error('decimal');
  if (extractProbability('27.8', 0.278) !== 27.8) throw new Error('bare number');
});
await test('multiNumberScore matches all expected answers', () => {
  const ref = { A: 11.5625, B: 16.5625, C: 16.875 };
  const text = 'A pays $11.5625, B pays $16.5625, C pays $16.875.';
  const m = multiNumberScore(text, ref, 0.05);
  if (m.matched !== 3) throw new Error(`matched: ${m.matched}/3`);
  if (m.score !== 1) throw new Error(`score: ${m.score}`);
});
await test('multiNumberScore partial match returns fractional score', () => {
  const ref = { A: 11.5625, B: 16.5625, C: 16.875 };
  const text = 'A pays $11.5625 and B pays $16.5625, but C is different.';
  const m = multiNumberScore(text, ref, 0.05);
  if (m.matched !== 2) throw new Error(`matched: ${m.matched}/3`);
  if (Math.abs(m.score - 2/3) > 0.01) throw new Error(`score: ${m.score}`);
});
await test('OOD math item (fair-share) now scores multi-number ref', async () => {
  const { OOD_BENCH } = await import('../dist/thinking/benchmarkSet.js');
  const item = OOD_BENCH.find(b => b.id === 'ood-01-fair-share');
  if (!item.reference.A) throw new Error('test setup: ref not flat');
  const r = await scoreOne(fakeCallChat, 'A: 11.5625, B: 16.5625, C: 16.875', item, {});
  if (r.score < 0.9) throw new Error(`score: ${r.score}`);
});

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
