// scripts/researchStockTest.js
// live test of the overhauled research pipeline in stock mode: quant math
// (Ito/GBM expected return, Sharpe, VaR) + real company/industry research,
// dated for today, with the humanize flag on. the report is saved to
// benchmarks/research/ so we can critique the OUTPUT and fix the PIPELINE.
//
// usage:
//   node scripts/researchStockTest.js [--ticker NVDA] [--model X] [--humanize] [--files a.pdf,b.docx]
//
// output:
//   benchmarks/research/stock-<ticker>-<n>.md   (the report)
//   benchmarks/research/stock-<ticker>-<n>.meta.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../dist/thinking/deepthink.js';
import runDeepResearch from '../dist/thinking/researchAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'benchmarks', 'research');
fs.mkdirSync(OUT, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const TICKER = arg('ticker', 'NVDA');
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const HUMANIZE = process.argv.includes('--humanize');
// --files a.pdf,b.docx — local docs converted to markdown and injected as
// max-credibility evidence sources alongside the web research
const FILES = (arg('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// pick the next free run number so we never clobber an earlier report
let runN = 1;
while (fs.existsSync(path.join(OUT, `stock-${TICKER}-${runN}.md`))) runN++;
const MD = path.join(OUT, `stock-${TICKER}-${runN}.md`);
const META = path.join(OUT, `stock-${TICKER}-${runN}.meta.json`);

const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = dt.callChat.bind(dt);

const topic = `Should I invest in ${TICKER} right now (as of 2026-08-10)? Give a rigorous buy/hold/sell recommendation backed by deep mathematics and quantitative research — Ito's lemma / geometric Brownian motion expected return, volatility, Sharpe ratio, and value at risk — paired with actual research on the company's latest financials, its industry status quo, competitive position, moat, catalysts, and risks. Use the most recent data available and cite every source.`;

async function main() {
  console.log(`[stockTest] model=${MODEL} ticker=${TICKER} humanize=${HUMANIZE} run=${runN}`);
  const t0 = Date.now();
  const result = await runDeepResearch(callChat, topic, {
    mode: 'stock',
    ticker: TICKER,
    maxQueries: 6,
    maxConcurrency: 3,
    credibilityThreshold: 30,
    maxSummaries: 8,
    useOllamaSearch: true,
    academicFilter: false,
    humanize: HUMANIZE,
    files: FILES,
  });
  const ms = Date.now() - t0;

  fs.writeFileSync(MD, result.report || '(no report)', 'utf-8');
  fs.writeFileSync(META, JSON.stringify({
    ticker: TICKER, model: MODEL, humanize: HUMANIZE, date: new Date().toISOString(),
    ms, success: result.success, claimCount: result.claimCount,
    referenceCount: (result.references || []).length,
    stepSummary: result.stepSummary,
    critiqueHistory: result.critiqueHistory,
  }, null, 2), 'utf-8');

  console.log(`\n[stockTest] ${result.success ? 'SUCCESS' : 'FAILED'} in ${(ms / 1000).toFixed(0)}s`);
  console.log(`[stockTest] claims=${result.claimCount} refs=${(result.references || []).length}`);
  console.log(`[stockTest] steps=${JSON.stringify(result.stepSummary, null, 2)}`);
  if (result.critiqueHistory?.length) {
    console.log(`[stockTest] critique loops=${result.critiqueHistory.length}`);
    for (const h of result.critiqueHistory) console.log(`  loop ${h.loop}: issues=${h.issueCount} score=${h.issueScore} critical=${h.criticalCount} expert=${h.expertAssessment}`);
  }
  console.log(`[stockTest] report saved: ${MD}`);
  console.log(`[stockTest] meta saved: ${META}`);
  console.log('\n================ REPORT (first 3000 chars) ================\n');
  console.log((result.report || '').slice(0, 3000));
  process.exit(result.success ? 0 : 1);
}

main().catch((e) => { console.error('[stockTest] fatal:', e); process.exit(1); });
