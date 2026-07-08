// scripts/probeOOD.js — score the best evolved prompt against the held-out OOD
// benchmark. if OOD fitness is much lower than in-distribution fitness, the
// prompt has overfit and should be re-evolved with a wider benchmark.
// usage: node scripts/probeOOD.js <runId>
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { evalCandidate, loadBest } from '../thinking/evolvedThinking.js';
import { OOD_BENCH } from '../thinking/benchmarkSet.js';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node scripts/probeOOD.js <runId>');
  process.exit(1);
}
const runDir = path.join(process.cwd(), 'data', 'evolved', runId);
if (!fs.existsSync(runDir)) {
  console.error(`no run dir: ${runDir}`);
  process.exit(1);
}
const best = loadBest(runDir);
const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';
const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
const dt = new Deepthink(model, [], opts);

console.log(`[ood] using best: ${best.id} op=${best.operator} idF=${best.fitness?.toFixed?.(3) || '?'}`);
console.log(`[ood] OOD bench: ${OOD_BENCH.length} held-out problems`);

(async () => {
  try {
    const r = await evalCandidate(dt.callChat.bind(dt), best, OOD_BENCH, opts);
    const oodFitness = r.score.aggregate;
    const idFitness = best.fitness || 0;
    const gap = idFitness - oodFitness;
    console.log(`\n[ood] in-dist fitness:  ${idFitness.toFixed(3)}`);
    console.log(`[ood] OOD fitness:      ${oodFitness.toFixed(3)}`);
    console.log(`[ood] gap (id - ood):   ${gap.toFixed(3)}`);
    if (gap > 0.20) {
      console.log(`[ood] WARNING: gap > 0.20 — the prompt is overfit. Re-evolve with a wider benchmark or fewer generations.`);
    } else {
      console.log(`[ood] OK: gap is small — the prompt generalizes.`);
    }
    // persist
    fs.writeFileSync(path.join(runDir, 'ood-score.json'),
      JSON.stringify({ idFitness, oodFitness, gap, detail: r.score.detail }, null, 2), 'utf-8');
    console.log(`[ood] saved to ${path.join(runDir, 'ood-score.json')}`);
  } catch (e) {
    console.error('[ood] FAIL:', e.message);
    process.exit(1);
  }
})();
