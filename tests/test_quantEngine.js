// tests/test_quantEngine.js
// model-free regression tests for the quant engine + conformance sweep.
// run 7 exposed: conflicting prices ($217.55 vs $223.96) made the writer
// and engine disagree; the repair loop oscillated instead of converging to
// the engine's numbers; merged claims duplicated citation titles.
// these tests pin the fixes: price/beta consensus (mode), deterministic
// numeric conformance, and per-URL citation metadata.

import { runQuantModel } from '../dist/thinking/quantEngine.js';
import { quantConformanceRepair, mergeDuplicateClaims } from '../dist/thinking/researchAgent.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- price consensus: 4 sources say $217.55, 1 says $223.96 → $217.55 ----
{
  const claims = [
    'NVDA is trading at $217.55, up 2% on the day.',
    'The current market price of Nvidia is $217.55 per share.',
    'Nvidia closed at $217.55 on Friday.',
    'Shares trade at $217.55 after earnings.',
    'Nvidia stock price for fiscal 2026 was $223.96.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ];
  const m = runQuantModel(claims);
  check('price consensus picks mode $217.55', m.price === 217.55, `got ${m.price}`);
  check('IV computed from consensus price', m.intrinsicValue != null, `got ${m.intrinsicValue}`);
}

// ---- price target never harvested, never rewritten ----
{
  const m = runQuantModel(['Analysts set a price target of $180 for NVDA.']);
  check('price target NOT harvested as current price', m.price === null, `got ${m.price}`);
  const rep = quantConformanceRepair('Analysts set a price target of $180 for NVDA.', { ok: true, price: 223.96, eps: 6.53, beta: 1.87, sigma: 0.367, costOfEquity: 0.1449, intrinsicValue: 1256.65, expectedPrice: 258.87, expectedLogReturn: 0.077, expectedReturn: 0.1449, sharpe: 0.28, var95_1d: 8.52, var99_1d: 12.05, var95_1y: 135.24 });
  check('conformance leaves price targets alone', rep.includes('$180'), rep);
}

// ---- run-7 divergence prose → engine numbers ----
{
  const q = { ok: true, price: 223.96, eps: 6.53, beta: 1.87, sigma: 0.367, costOfEquity: 0.1449, intrinsicValue: 1256.65, expectedPrice: 258.87, expectedLogReturn: 0.077, expectedReturn: 0.1449, sharpe: 0.28, var95_1d: 8.52, var99_1d: 12.05, var95_1y: 135.24 };
  const prose = `NVDA's current market price is observed at $217.55 [Source 1, Source 2]. A DCF yields an intrinsic value of $241.18 per share (based on a WACC of 9.5%). The expected price of $254.71 in one year and an expected annual return of 15% follow from a volatility of 45%. The Sharpe ratio of 0.36 and a 1-day 95% VaR of $8.42 round out the risk picture. The stock carries a beta of 1.7.`;
  const rep = quantConformanceRepair(prose, q);
  check('price rewritten to engine consensus', rep.includes('$223.96'), rep);
  check('intrinsic value rewritten', rep.includes('$1256.65'), rep);
  check('WACC rewritten to Re', rep.includes('WACC of 14.49%'), rep);
  check('expected price rewritten to E[S_T]', rep.includes('$258.87'), rep);
  check('expected annual return rewritten to mu', rep.includes('15%') === false && rep.includes('14.5%'), rep);
  check('volatility rewritten to sigma', rep.includes('36.7%'), rep);
  check('Sharpe rewritten', rep.includes('0.28'), rep);
  check('VaR rewritten', rep.includes('$8.52'), rep);
  check('beta rewritten', rep.includes('1.87'), rep);
  check('citation tags preserved', rep.includes('[Source 1, Source 2]'), rep);
}

// ---- negative cases: engine metrics must NOT be clobbered ----
{
  const q = { ok: true, price: 223.96, eps: 6.53, beta: 1.87, sigma: 0.367, costOfEquity: 0.1449, intrinsicValue: 1256.65, expectedPrice: 258.87, expectedLogReturn: 0.077, expectedReturn: 0.1449, sharpe: 0.28, var95_1d: 8.52, var99_1d: 12.05, var95_1y: 135.24 };
  const prose = 'Quarterly EPS of $1.30 for Q3 FY2026 [Source 3]. The volatility drag sigma^2/2 is 6.7%. A 1-day 99% VaR of $12.05 and a 1-year 95% VaR of $135.24. Analysts forecast price guidance of $180.';
  const rep = quantConformanceRepair(prose, q);
  check('quarterly EPS untouched', rep.includes('$1.30'), rep);
  check('volatility drag untouched', rep.includes('6.7%'), rep);
  check('99% VaR untouched (already engine)', rep.includes('$12.05'), rep);
  check('1y VaR untouched (already engine)', rep.includes('$135.24'), rep);
  check('forecast guidance untouched', rep.includes('$180'), rep);
}

// ---- EPS + beta consensus + annual preference still hold ----
{
  const m = runQuantModel([
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Nvidia reported diluted EPS of $6.54 on a TTM basis.',
    'Q3 FY2026 EPS was $1.30.',
    'Beta (5Y Monthly) is 2.21. A 52-week range of $95.',
    'The beta is 1.87 per Yahoo Finance.',
  ]);
  check('EPS prefers annual (6.53 not 1.30)', m.eps === 6.53, `got ${m.eps}`);
  check('beta consensus picks 1.87', m.beta === 1.87, `got ${m.beta}`);
}

// ---- scanPriceForwardAll still rescues wordy phrasings ----
{
  const m = runQuantModel(['The share price for fiscal 2026 was $150.42, up 5% on strong earnings.']);
  check('wordy price phrasing still harvested', m.price === 150.42, `got ${m.price}`);
}

// ---- merged claims keep per-URL citation metadata ----
{
  const nodes = [
    { claim: 'NVDA beta is 1.87 according to data', url: 'https://a.com/beta', title: 'NVDA Beta History - A.com', citation: { data: { title: 'NVDA Beta History - A.com' } }, publicationDate: '2026-01-01' },
    { claim: 'The stock beta of 1.87 reported by the exchange', url: 'https://b.org/beta', title: 'Nvidia Stock Beta - B.org', citation: { data: { title: 'Nvidia Stock Beta - B.org' } }, publicationDate: '2026-02-01' },
  ];
  const merged = mergeDuplicateClaims(nodes);
  check('claims merged', merged.length === 1, `got ${merged.length}`);
  check('both urls kept', (merged[0].urls || []).length === 2, JSON.stringify(merged[0].urls));
  check('per-URL metadata kept', merged[0].srcMeta && merged[0].srcMeta.length === 2 && merged[0].srcMeta[1].title === 'Nvidia Stock Beta - B.org', JSON.stringify(merged[0].srcMeta));
}

console.log(`\nquantEngine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
