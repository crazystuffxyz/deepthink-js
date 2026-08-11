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

// ---- run-9: glitched quote page claims $8.00, real price ~$217 ----
// the source page really said "current price $8.00 (Closed)" and repeated
// it for after-hours; every other signal said ~$217. the after-hours ban
// kills 2 of the 3 bogus votes, and clusterPick keeps the lone $8.00 from
// winning a plurality against the $217 cluster.
{
  const m = runQuantModel([
    'The current price of NVDA on 2026-08-10 is $8.00 (Closed).',
    'The after-hours price of NVDA on 2026-08-10 is $8.00.',
    'The after-hours price of NVDA is $8.00 as of 7:30 PM EST.',
    'The after-hours trading range for NVDA on 2026-08-10 is $217.35 to $219.66.',
    'Nvidia stock price for fiscal 2026 was $223.96.',
    'Nvidia is trading at $217.55.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('after-hours quotes banned', m.price !== 8.00, `got ${m.price}`);
  check('price cluster picks ~$217', m.price != null && m.price > 200 && m.price < 230, `got ${m.price}`);
}

// ---- run-11: "trades at 27 times forward earnings" is a P/E multiple ----
{
  const m = runQuantModel([
    'Nvidia\'s dominant position has led it to trade at 27 times forward earnings.',
    'Nvidia is trading at $190.04.',
    'Diluted EPS for fiscal year 2026 stood at $4.43.',
    'Revenue grew 62% year over year.',
    'The beta is 1.87.',
  ]);
  check('P/E multiple NOT harvested as price', m.price === 190.04, `got ${m.price}`);
  const m2 = runQuantModel(['The stock trades at 27x forward earnings.']);
  check('27x multiple NOT harvested', m2.price === null, `got ${m2.price}`);
  const rep = quantConformanceRepair('Nvidia trades at 27 times forward earnings, a premium valuation.', { ok: true, price: 190.04, eps: 4.43, beta: 1.87, sigma: 0.4, costOfEquity: 0.1449, intrinsicValue: 55.36, expectedPrice: 220.0, expectedLogReturn: 0.07, expectedReturn: 0.1449, sharpe: 0.26, var95_1d: 4.7, var99_1d: 6.6, var95_1y: 125.0 });
  check('conformance leaves P/E multiple alone', rep.includes('27 times forward earnings'), rep);
}

// ---- run-12: "PEG Ratio (5yr expected): 0.55" — the parenthetical must
// not capture the "5" in "(5yr" (growth was 4.6% instead of 41.6%) ----
{
  const m = runQuantModel([
    'Nvidia is trading at $190.04.',
    'Diluted EPS for fiscal year 2026 stood at $4.43.',
    'The forward P/E (5yr) is 22.88.',
    'PEG Ratio (5yr expected): 0.55',
    'The beta is 1.87.',
  ]);
  check('PEG parenthetical skipped (0.55 not 5)', m.growth != null && Math.abs(m.growth - 0.416) < 0.01, `got ${m.growth}`);
  check('forward P/E parenthetical skipped (22.88 not 5)', m.intrinsicValue != null, `got ${m.intrinsicValue}`);
}

// ---- run-12b: same PEG bug via the "5-year expected" phrasing ----
{
  const m = runQuantModel([
    'Nvidia is trading at $190.04.',
    'Diluted EPS for fiscal year 2026 stood at $4.43.',
    'The 5-year expected PEG ratio is 0.55.',
    'The forward P/E is 22.88.',
    'The beta is 1.87.',
  ]);
  check('PEG 5-year phrasing still derived', m.growth != null && Math.abs(m.growth - 0.416) < 0.01, `got ${m.growth}`);
}

// ---- run-9/12: glitched quote page says $8.00 but market cap ÷ shares
// says ~$200 — the implied price must win ----
{
  const m = runQuantModel([
    'The current price of NVDA on 2026-08-10 is $8.00 (Closed).',
    'NVDA is trading at $8.00 as of August 10, 2026.',
    'Nvidia has a market capitalization of 4.86 trillion USD.',
    'The company has 24.20 billion shares outstanding.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('implausible quote rejected via market cap ÷ shares', m.price != null && m.price > 150 && m.price < 250, `got ${m.price}`);
}

// ---- implied price fills the slot when no quote is harvested at all ----
{
  const m = runQuantModel([
    'Nvidia has a market capitalization of 4.86 trillion USD.',
    'The company has 24.20 billion shares outstanding.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('implied price used when quote missing', m.price != null && m.price > 150 && m.price < 250, `got ${m.price}`);
}

// ---- a sane quote within 2x of the implied price is kept ----
{
  const m = runQuantModel([
    'Nvidia is trading at $217.55.',
    'Nvidia has a market capitalization of 4.86 trillion USD.',
    'The company has 24.20 billion shares outstanding.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('sane quote kept over implied price', m.price === 217.55, `got ${m.price}`);
}

// ---- clusterPick: a genuinely cheap stock still clusters at its own level ----
{
  const m = runQuantModel([
    'The stock is trading at $8.00.',
    'The current market price of the stock is $8.00 per share.',
    'The stock closed at $8.00 on Friday.',
    'Diluted EPS for fiscal year 2026 stood at $0.24.',
    'Revenue grew 12% year over year.',
    'The beta is 0.9.',
  ]);
  check('cheap stock keeps its own price', m.price === 8.00, `got ${m.price}`);
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

// ---- run 15: the same source page produced several claims that all merged
// into one node — duplicate URLs mapped to the same ref id and the writer
// emitted "[Source 1, Source 1, Source 1...]" ×16. urls must dedupe ----
{
  const nodes = [
    { claim: 'NVDA revenue hit $215.9 billion in FY2026.', url: 'https://a.com/nvda', title: 'NVDA Financials - A.com', citation: { data: { title: 'NVDA Financials - A.com' } }, publicationDate: '2026-01-01' },
    { claim: 'NVDA revenue was $215.9 billion for fiscal 2026.', url: 'https://a.com/nvda', title: 'NVDA Financials - A.com', citation: { data: { title: 'NVDA Financials - A.com' } }, publicationDate: '2026-01-01' },
    { claim: 'NVDA reported $215.9B in revenue last fiscal year.', url: 'https://a.com/nvda', title: 'NVDA Financials - A.com', citation: { data: { title: 'NVDA Financials - A.com' } }, publicationDate: '2026-01-01' },
    { claim: 'NVDA revenue reached 215.9 billion dollars in FY26.', url: 'https://b.org/nvda', title: 'NVDA Revenue - B.org', citation: { data: { title: 'NVDA Revenue - B.org' } }, publicationDate: '2026-02-01' },
  ];
  const merged = mergeDuplicateClaims(nodes);
  check('all 4 merged into one', merged.length === 1, `got ${merged.length}`);
  check('duplicate URLs deduped', (merged[0].urls || []).length === 2, JSON.stringify(merged[0].urls));
  check('srcMeta deduped too', merged[0].srcMeta.length === 2, JSON.stringify(merged[0].srcMeta));
}

// ---- the References section is metadata — NEVER swept (run 8: beta rule
// matched "beta" in a URL and rewrote "[5]" into "[2.21]") ----
{
  const q = { ok: true, price: 217.55, eps: 6.53, beta: 2.21, sigma: 0.367, costOfEquity: 0.16355, intrinsicValue: 55.36, expectedPrice: 256.21, expectedLogReturn: 0.096, expectedReturn: 0.16355, sharpe: 0.33, var95_1d: 8.28, var99_1d: 11.70, var95_1y: 131.37 };
  const report = 'The stock carries a beta of 1.9 and trades at $210.\n\n---\n## References\n\n[4] (2026). *NVDA Stock Beta History & Chart Since 1999*. Wall Street Numbers. https://wallstreetnumbers.com/stocks/nvda/beta\n[5] (2026). *NVDA Stock Volatility History & Chart Since 1999*. Wall Street Numbers. https://wallstreetnumbers.com/stocks/nvda/volatility';
  const rep = quantConformanceRepair(report, q);
  check('body swept', rep.includes('beta of 2.21') && rep.includes('$217.55'), rep);
  check('ref [4] title untouched', rep.includes('Since 1999*. Wall Street Numbers. https://wallstreetnumbers.com/stocks/nvda/beta'), rep);
  check('ref [5] id untouched', rep.includes('[5] (2026). *NVDA Stock Volatility'), rep);
  check('ref id not corrupted', !rep.includes('[2.21]'), rep);
}

// ---- run-8 residual gaps: no-$ price phrasing, "expected MEAN price",
// and the clobber risks that optional-$ opens up ----
{
  const q = { ok: true, price: 217.55, eps: 6.53, beta: 2.21, sigma: 0.367, costOfEquity: 0.16355, intrinsicValue: 55.36, expectedPrice: 256.21, expectedLogReturn: 0.096, expectedReturn: 0.16355, sharpe: 0.33, var95_1d: 8.28, var99_1d: 11.70, var95_1y: 131.37 };
  const prose = 'NVDA is trading at a current price of 218.14 USD [Source 1-7]. The expected mean price of $217.55 in one year based on GBM. The stock closed at 52-week high of $150. The market price of NVDA fell 5% to $210. Trading at levels not seen since 2021. EPS growth of 5% year over year.';
  const rep = quantConformanceRepair(prose, q);
  check('no-$ price phrase aligned', rep.includes('218.14') === false && rep.includes('217.55 USD'), rep);
  check('expected mean price aligned to E[S_T]', rep.includes('expected mean price of $256.21'), rep);
  check('52-week high untouched', rep.includes('52-week high of $150'), rep);
  check('%-move untouched', rep.includes('fell 5% to $210'), rep);
  check('year-like price untouched', rep.includes('since 2021'), rep);
  check('EPS growth % untouched', rep.includes('EPS growth of 5%'), rep);
}

// ---- run-16: the $8.00 glitch struck again with NO shares-outstanding
// claim — the implied-price check had nothing to divide by. the 52-week
// range ($164.07–$236.54) is the cross-check that still works ----
{
  const m = runQuantModel([
    'NVDA is trading at $8.00 on August 7, 2026.',
    'Over the past year, NVDA stock traded between $164.07 and $236.54.',
    'The market cap sat at roughly $5,269,279 million.',
    'Diluted EPS for fiscal year 2026 stood at $4.90.',
    'Revenue grew 85% year over year.',
    'The beta is 1.84.',
  ]);
  check('quote outside 52-week range rejected', m.price == null || m.price > 150, `got ${m.price}`);
  check('priceSource says rejected', m.priceSource != null && m.priceSource.includes('52-week'), m.priceSource);
}

// ---- range check with implied price available: implied wins ----
{
  const m = runQuantModel([
    'NVDA hit $8.00 on August 7, 2026.',
    'Over the past year, NVDA stock traded between $164.07 and $236.54.',
    'Nvidia has a market capitalization of 4.86 trillion USD.',
    'The company has 24.20 billion shares outstanding.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('implied price wins over range-rejected quote', m.price != null && m.price > 150 && m.price < 250, `got ${m.price}`);
}

// ---- a quote INSIDE the 52-week range is kept ----
{
  const m = runQuantModel([
    'NVDA is trading at $217.55.',
    'Over the past year, NVDA stock traded between $164.07 and $236.54.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('in-range quote kept', m.price === 217.55, `got ${m.price}`);
}

// ---- run-18: "after-hours price as of 2026-08-11 at 8:00 PM" — the
// date/time components (08, 11, 8, 00) were harvested as prices and
// "8:00 PM" appeared in 4+ claims, so $8.00 became the mode and the whole
// model computed against it. date (-, /) and time (:) flanks disqualify ----
{
  const m = runQuantModel([
    'NVIDIA (NVDA) after-hours price as of 2026-08-11 at 8:00 PM was $217.99.',
    'After-hours trading runs from 4:00 PM to 8:00 PM ET.',
    'NVDA closed at $217.55 on 2026-08-10.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('8:00 PM not harvested as price', m.price === 217.55, `got ${m.price}`);
}

// ---- run-18: "The 52-week price range for NVDA as of 2026-08-10 is
// between 163.85 and 236.26" — the 25-char window couldn't reach the real
// numbers, the first regex captured the DATE (2026, 08), and a
// matched-but-garbage first alternative blocked the good ones via ??. the
// chain now validates every candidate and falls through to the "between"
// phrasing ----
{
  const m = runQuantModel([
    'NVDA is trading at $8.00 on August 7, 2026.',
    'The 52-week price range for NVDA as of 2026-08-10 is between 163.85 and 236.26.',
    'Diluted EPS for fiscal year 2026 stood at $4.90.',
    'Revenue grew 85% year over year.',
    'The beta is 1.84.',
  ]);
  check('wordy 52-week range phrasing still rejects bad quote', m.price == null || m.price > 150, `got ${m.price}`);
  check('wordy range priceSource says rejected', m.priceSource != null && m.priceSource.includes('52-week'), m.priceSource);
}

// ---- years are not ranges: "between 2026 and 2028" must not reject a
// sane price ----
{
  const m = runQuantModel([
    'NVDA is trading at $217.55.',
    'The market is expected to grow between 2026 and 2028.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'The beta is 1.87.',
  ]);
  check('year range does not reject sane price', m.price === 217.55, `got ${m.price}`);
}

// ---- run-15: "TTM EPS growth is 214.42%" — the EPS window crossed
// "growth is" and captured the growth RATE as the EPS value ($214.42 EPS
// → IV $52,671). rates are never EPS: growth/cagr words in the window and
// a % right after the number both disqualify ----
{
  const m = runQuantModel([
    'NVDA Trailing Twelve Months (TTM) diluted earnings per share is $6.53 as of 2026.',
    'NVIDIA\'s TTM EPS growth is 214.42% as of 2026.',
    'NVDA diluted EPS TTM CAGR is 71.00%.',
    'NVDA long-term diluted EPS CAGR over 10 years is 75.00%.',
    'NVDA diluted EPS for the quarter ending 2026-03-31 was $2.39.',
    'NVDA stock price is $217.55.',
    'NVDA beta is 1.87.',
    'NVDA volatility is 40.1%.',
    'risk-free rate 4.2%, equity risk premium 5.5%',
  ]);
  check('EPS growth % NOT harvested as EPS', m.eps === 6.53, `got ${m.eps}`);
  check('EPS CAGR NOT harvested as EPS', m.eps === 6.53, `got ${m.eps}`);
  check('IV sane with capped growth', m.intrinsicValue != null && m.intrinsicValue < 1000, `got ${m.intrinsicValue}`);
}

// ---- run-15: "54% expect that growth to be 11% or more" — the loose
// growth window crossed "2026, and" and grabbed the survey share (54%)
// as the growth rate. the %→growth-word gap is tight now, and the
// post-growth window is digit-safe ----
{
  const m = runQuantModel([
    'About 93% of leaders expect revenue growth in 2026, and 54% expect that growth to be 11% or more.',
    'NVDA stock price is $217.55.',
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'NVDA 3-year EPS CAGR is 64%.',
    'NVDA beta is 1.87.',
    'NVDA volatility is 40.1%.',
    'risk-free rate 4.2%, equity risk premium 5.5%',
  ]);
  check('survey share NOT harvested as growth', m.growth != null && Math.abs(m.growth - 0.54) > 0.01, `got ${m.growth}`);
  check('CAGR fallback feeds the DCF', m.intrinsicValue != null, `got ${m.intrinsicValue}`);
}

// ---- run-15: the EPS after-window must not cross into the next claim
// ("...$6.53. Revenue grew 50%") and see its % ----
{
  const m = runQuantModel([
    'Diluted EPS for fiscal year 2026 stood at $6.53.',
    'Revenue grew 50% year over year.',
    'NVDA stock price is $217.55.',
    'NVDA beta is 1.87.',
    'NVDA volatility is 40.1%.',
    'risk-free rate 4.2%, equity risk premium 5.5%',
  ]);
  check('EPS kept when next claim has a %', m.eps === 6.53, `got ${m.eps}`);
}

console.log(`\nquantEngine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
