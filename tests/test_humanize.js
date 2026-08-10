// test_humanize.js — unit tests for the humanize loop + claim preservation
'use strict';

import { humanizeText, AI_TELL_WORDS, extractClaims, claimsSurvived } from '../dist/thinking/humanize.js';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

console.log('test_humanize');

// fake LLM: routes on the system prompt to simulate each stage
function makeFake({ humanize, integrity, fix, detect }) {
  return async (msgs, stream, cb, opts) => {
    const sys = String(msgs[0]?.content || '');
    if (sys.includes('AI-text detector')) return { content: detect };
    if (sys.includes('meticulous copy editor')) return { content: integrity };
    if (sys.includes('careful editor')) return { content: fix };
    if (sys.includes('human writer')) return { content: humanize };
    return { content: '' };
  };
}

await test('AI_TELL_WORDS has the classic tells', () => {
  for (const w of ['delve', 'furthermore', 'moreover', 'comprehensive', 'robust', 'seamless']) {
    if (!AI_TELL_WORDS.includes(w)) throw new Error(`missing ${w}`);
  }
});

await test('extractClaims finds numbers, percents, dollars, source tags', () => {
  const claims = extractClaims('Revenue grew 12.5% to $4.2b in 2024 [Source 3]. 1,000,000 users.');
  for (const c of ['12.5%', '$4.2b', '2024', '[Source 3]', '1,000,000']) {
    if (!claims.includes(c)) throw new Error(`missing claim ${c}: ${claims.join(',')}`);
  }
});

await test('claimsSurvived: all present → empty', () => {
  const missing = claimsSurvived('12.5% growth in 2024 [Source 3]', 'growth hit 12.5% back in 2024 [Source 3]');
  if (missing.length) throw new Error(`unexpected missing: ${missing.join(',')}`);
});

await test('claimsSurvived: dropped number is caught', () => {
  const missing = claimsSurvived('Revenue grew 12.5% in 2024', 'Revenue grew a lot last year');
  if (!missing.includes('12.5%')) throw new Error(`12.5% not flagged: ${missing.join(',')}`);
});

await test('humanizeText: clean loop terminates at score 0', async () => {
  const callChat = makeFake({
    humanize: 'Revenue grew 12.5% in 2024. That is a lot. [Source 3]',
    integrity: '{"issues": [], "ok": true}',
    fix: 'Revenue grew 12.5% in 2024. That is a lot. [Source 3]',
    detect: '{"aiScore": 0, "tells": [], "verdict": "human"}'
  });
  const r = await humanizeText(callChat, 'Furthermore, revenue grew 12.5% in 2024 [Source 3].', { maxIterations: 3 });
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  if (r.iterations !== 1) throw new Error(`expected 1 iteration, got ${r.iterations}`);
  if (r.finalScore !== 0) throw new Error(`expected score 0, got ${r.finalScore}`);
  if (!r.text.includes('12.5%')) throw new Error('number lost');
  if (!r.text.includes('[Source 3]')) throw new Error('citation lost');
});

await test('humanizeText: dropped claim triggers fix pass and is restored', async () => {
  let fixCalled = false;
  const callChat = makeFake({
    // humanizer drops the number — integrity says ok (bad judge), local backstop must catch it
    humanize: 'Revenue grew a lot last year. [Source 3]',
    integrity: '{"issues": [], "ok": true}',
    fix: (() => { fixCalled = true; return 'Revenue grew 12.5% last year. [Source 3]'; })(),
    detect: '{"aiScore": 0, "tells": [], "verdict": "human"}'
  });
  const r = await humanizeText(callChat, 'Revenue grew 12.5% in 2024 [Source 3].', { maxIterations: 3 });
  if (!fixCalled) throw new Error('fix pass never ran — backstop failed');
  if (!r.text.includes('12.5%')) throw new Error(`number not restored: ${r.text}`);
});

await test('humanizeText: detector keeps flagging → max iterations, ok=false', async () => {
  const callChat = makeFake({
    humanize: 'Revenue grew 12.5% in 2024. [Source 3]',
    integrity: '{"issues": [], "ok": true}',
    fix: 'Revenue grew 12.5% in 2024. [Source 3]',
    detect: '{"aiScore": 85, "tells": ["uniform rhythm"], "verdict": "ai"}'
  });
  const r = await humanizeText(callChat, 'Revenue grew 12.5% in 2024 [Source 3].', { maxIterations: 2 });
  if (r.ok) throw new Error('expected ok=false');
  if (r.iterations !== 2) throw new Error(`expected 2 iterations, got ${r.iterations}`);
  if (r.history.length !== 2) throw new Error('history should have 2 entries');
});

await test('humanizeText: References section is never touched (run 10)', async () => {
  // the humanizer would drop the whole References section; the split must
  // keep it out of the loop entirely and re-attach it verbatim
  const refs = '\n---\n## References\n\n[1] (2026). *NVDA Stock Price Today*. Tickzen. https://tickzen.app/stocks/nvda/overview\n[2] (2026). *NVIDIA Corporation (NVDA) Stock Price, News, Quote & History - Yahoo Finance*. Yahoo Finance. https://finance.yahoo.com/quote/NVDA/';
  const body = 'Furthermore, revenue grew 12.5% in 2024 [Source 3].';
  const callChat = makeFake({
    humanize: 'Revenue grew 12.5% in 2024. That is a lot. [Source 3]',
    integrity: '{"issues": [], "ok": true}',
    fix: 'Revenue grew 12.5% in 2024. That is a lot. [Source 3]',
    detect: '{"aiScore": 0, "tells": [], "verdict": "human"}'
  });
  const r = await humanizeText(callChat, body + refs, { maxIterations: 3 });
  if (!r.text.includes('## References')) throw new Error('References section dropped');
  if (!r.text.includes('https://tickzen.app/stocks/nvda/overview')) throw new Error('reference URL lost');
  if (!r.text.includes('https://finance.yahoo.com/quote/NVDA/')) throw new Error('reference URL lost');
  if (!r.text.includes('12.5%')) throw new Error('body number lost');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
