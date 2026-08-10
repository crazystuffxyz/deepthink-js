// scripts/researchTestQuery.js
// the Phase-3 test query: run the optimized research pipeline on a topic
// COMPLETELY different from the stock-training query, exercising the flags
// (humanize, outputFormat, mode) to prove the pipeline is well-rounded.
//
// usage:
//   node scripts/researchTestQuery.js [--topic "..." ] [--model X]
//       [--format markdown|plain|json|html] [--humanize] [--files a.pdf]
//
// output:
//   benchmarks/research/test-<n>.md / .html / .json / .txt  + .meta.json

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
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const FORMAT = arg('format', 'markdown');
const HUMANIZE = process.argv.includes('--humanize');
const FILES = (arg('files', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOPIC = arg('topic', '') || 'Explain how CRISPR-Cas9 gene editing works, what its current clinical applications are, and analyze the main ethical debates around germline editing. Cite every source.';

let runN = 1;
while (fs.existsSync(path.join(OUT, `test-${runN}.md`))) runN++;
const EXT = FORMAT === 'html' ? 'html' : FORMAT === 'json' ? 'json' : FORMAT === 'plain' ? 'txt' : 'md';
const MD = path.join(OUT, `test-${runN}.${EXT}`);
const META = path.join(OUT, `test-${runN}.meta.json`);

const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = dt.callChat.bind(dt);

async function main() {
  console.log(`[testQuery] model=${MODEL} format=${FORMAT} humanize=${HUMANIZE} run=${runN}`);
  console.log(`[testQuery] topic: ${TOPIC.slice(0, 100)}...`);
  const t0 = Date.now();
  const result = await runDeepResearch(callChat, TOPIC, {
    mode: 'general',
    maxQueries: 8,
    maxConcurrency: 3,
    credibilityThreshold: 30,
    maxSummaries: 10,
    useOllamaSearch: true,
    academicFilter: false,
    humanize: HUMANIZE,
    outputFormat: FORMAT,
    files: FILES,
  });
  const ms = Date.now() - t0;

  fs.writeFileSync(MD, result.report || '(no report)', 'utf-8');
  fs.writeFileSync(META, JSON.stringify({
    topic: TOPIC, model: MODEL, format: FORMAT, humanize: HUMANIZE, date: new Date().toISOString(),
    ms, success: result.success, claimCount: result.claimCount,
    referenceCount: (result.references || []).length,
    stepSummary: result.stepSummary,
    critiqueHistory: result.critiqueHistory,
  }, null, 2), 'utf-8');

  console.log(`\n[testQuery] ${result.success ? 'SUCCESS' : 'FAILED'} in ${(ms / 1000).toFixed(0)}s`);
  console.log(`[testQuery] claims=${result.claimCount} refs=${(result.references || []).length}`);
  console.log(`[testQuery] steps=${JSON.stringify(result.stepSummary, null, 2)}`);
  if (result.critiqueHistory?.length) {
    console.log(`[testQuery] critique loops=${result.critiqueHistory.length}`);
    for (const h of result.critiqueHistory) console.log(`  loop ${h.loop}: issues=${h.issueCount} score=${h.issueScore} critical=${h.criticalCount} expert=${h.expertAssessment}`);
  }
  console.log(`[testQuery] report saved: ${MD}`);
  console.log(`[testQuery] meta saved: ${META}`);
  console.log('\n================ REPORT (first 2500 chars) ================\n');
  console.log((result.report || '').slice(0, 2500));
  process.exit(result.success ? 0 : 1);
}

main().catch((e) => { console.error('[testQuery] fatal:', e); process.exit(1); });
