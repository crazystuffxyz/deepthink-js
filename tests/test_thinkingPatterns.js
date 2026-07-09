// test_thinkingPatterns.js — pure unit tests for the patterns module
'use strict';

import {
  PATTERNS, PATTERN_BY_NAME, samplePatterns, composePrompt, fingerprint, patternsIn,
  fableMetaPrompt, fableFingerprint
} from '../dist/thinking/thinkingPatterns.js';

let pass = 0, fail = 0;
function test(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

console.log('test_thinkingPatterns');

test('PATTERNS has 25+ entries', () => {
  if (PATTERNS.length < 25) throw new Error(`only ${PATTERNS.length}`);
});
test('every pattern has name/move/when/template', () => {
  for (const p of PATTERNS) {
    if (!p.name) throw new Error('missing name');
    if (!p.move) throw new Error(`${p.name}: missing move`);
    if (!p.when) throw new Error(`${p.name}: missing when`);
    if (!p.template) throw new Error(`${p.name}: missing template`);
  }
});
test('PATTERN_BY_NAME lookup works', () => {
  for (const p of PATTERNS) {
    const got = PATTERN_BY_NAME[p.name];
    if (!got || got.name !== p.name) throw new Error(`lookup failed: ${p.name}`);
  }
});
test('samplePatterns(3) returns 3 distinct', () => {
  const out = samplePatterns(3);
  if (out.length !== 3) throw new Error(`got ${out.length}`);
  const ids = new Set(out.map(p => p.name));
  if (ids.size !== 3) throw new Error('duplicates');
});
test('samplePatterns is deterministic given seeded rng', () => {
  let seed = 42;
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const a = samplePatterns(4, rng).map(p => p.name);
  seed = 42;
  const b = samplePatterns(4, rng).map(p => p.name);
  if (a.join(',') !== b.join(',')) throw new Error('not deterministic');
});
test('composePrompt returns non-empty string', () => {
  const s = composePrompt([PATTERNS[0], PATTERNS[1]], { tone: 'neutral' });
  if (typeof s !== 'string' || s.length < 50) throw new Error('too short');
  if (!s.includes(PATTERNS[0].name) || !s.includes(PATTERNS[1].name)) throw new Error('missing names');
});
test('fingerprint detects tone and patterns', () => {
  const s = composePrompt([PATTERNS[0], PATTERNS[5]], { tone: 'socratic' });
  const fp = fingerprint(s);
  if (fp.tone !== 'socratic') throw new Error(`tone: ${fp.tone}`);
  if (fp.n !== 2) throw new Error(`n: ${fp.n}`);
  if (!fp.names.includes(PATTERNS[0].name)) throw new Error('missing pattern name');
});
test('patternsIn extracts referenced patterns', () => {
  const s = 'I will use feynman-decompose and erdos-counterexample and knuth-worst-case.';
  const ps = patternsIn(s);
  if (ps.length !== 3) throw new Error(`got ${ps.length}`);
  if (!ps.find(p => p.name === 'feynman-decompose')) throw new Error('missing feynman');
});
test('fableMetaPrompt default medium contains <thinking> and 4 stages', () => {
  const s = fableMetaPrompt({ profile: 'default', intensity: 'medium' });
  if (!s.includes('<thinking>')) throw new Error('no think block');
  if (!/STAGE 1/.test(s) || !/STAGE 2/.test(s) || !/STAGE 3/.test(s) || !/STAGE 4/.test(s)) throw new Error('missing stages');
  if (!/actually/.test(s) && !/wait/.test(s)) throw new Error('no self-correction marker');
});
test('fableMetaPrompt high has 5 stages', () => {
  const s = fableMetaPrompt({ intensity: 'high' });
  if (!/STAGE 5/.test(s)) throw new Error('no STAGE 5');
});
test('fableMetaPrompt low has 2 stages', () => {
  const s = fableMetaPrompt({ intensity: 'low' });
  if (!/STAGE 1/.test(s) || !/STAGE 2/.test(s)) throw new Error('missing 1 or 2');
  if (/STAGE 3/.test(s)) throw new Error('unexpected STAGE 3');
});
test('fableMetaPrompt math profile uses ramanujan/erdos', () => {
  const s = fableMetaPrompt({ profile: 'math' });
  if (!s.includes('ramanujan-intuition')) throw new Error('no ramanujan');
  if (!s.includes('erdos-counterexample')) throw new Error('no erdos');
});
test('fableMetaPrompt code profile uses knuth/dijkstra', () => {
  const s = fableMetaPrompt({ profile: 'code' });
  if (!s.includes('knuth-worst-case')) throw new Error('no knuth');
  if (!s.includes('dijkstra-structured-program')) throw new Error('no dijkstra');
});
test('fableFingerprint detects fable think format', () => {
  const s = fableMetaPrompt();
  const fp = fableFingerprint(s);
  if (!fp.hasFable) throw new Error('hasFable false');
  if (!fp.hasClassify) throw new Error('hasClassify false');
  if (fp.tone !== 'meta') throw new Error(`tone: ${fp.tone}`);
});
test('fable-think-format pattern exists in PATTERNS', () => {
  const p = PATTERN_BY_NAME['fable-think-format'];
  if (!p) throw new Error('missing pattern');
  if (!p.template.includes('<thinking>')) throw new Error('template missing think block');
});
test('classify-then-route pattern exists in PATTERNS', () => {
  const p = PATTERN_BY_NAME['classify-then-route'];
  if (!p) throw new Error('missing pattern');
  if (!/ASSERTION/.test(p.template) || !/STUCK/.test(p.template)) throw new Error('no classification');
});
test('neumann-internal-critic pattern exists in PATTERNS', () => {
  const p = PATTERN_BY_NAME['neumann-internal-critic'];
  if (!p) throw new Error('missing pattern');
});
test('explicit-uncertainty pattern exists in PATTERNS', () => {
  const p = PATTERN_BY_NAME['explicit-uncertainty'];
  if (!p) throw new Error('missing pattern');
  if (!/CONFIDENCE/.test(p.template)) throw new Error('no confidence');
});

await test('PATTERN_BY_NAME has all PATTERNS', () => {
  for (const p of PATTERNS) {
    if (PATTERN_BY_NAME[p.name] !== p) throw new Error(`missing ${p.name}`);
  }
});
await test('4 new puzzle/IQ patterns are present', () => {
  const names = PATTERNS.map(p => p.name);
  for (const want of ['eliminate-systematically', 'sequence-mine', 'extract-constraints', 'commit-and-defend']) {
    if (!names.includes(want)) throw new Error(`missing: ${want}`);
  }
});
await test('fable puzzle profile includes the new IQ moves', () => {
  const sys = fableMetaPrompt({ profile: 'puzzle', intensity: 'medium' });
  for (const want of ['eliminate-systematically', 'sequence-mine', 'extract-constraints', 'commit-and-defend']) {
    if (!sys.includes(want)) throw new Error(`puzzle profile missing: ${want}`);
  }
  if (!/<thinking>/.test(sys)) throw new Error('puzzle profile should keep fable think block');
});

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
