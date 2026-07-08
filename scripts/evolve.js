// scripts/evolve.js — run prompt evolution against the default test model.
// usage: node scripts/evolve.js [popSize] [generations]
//   popSize: number of candidates per generation (default 10)
//   generations: how many generations to evolve (default 6)
'use strict';

import Deepthink from '../thinking/deepthink.js';
import { evolvePrompts } from '../thinking/evolvedThinking.js';
import { BENCH, OOD_BENCH } from '../thinking/benchmarkSet.js';

const popSize = parseInt(process.argv[2] || '10', 10);
const generations = parseInt(process.argv[3] || '6', 10);
const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';

console.log(`[evolve] model=${model} pop=${popSize} gens=${generations}`);
console.log(`[evolve] benchmark: ${BENCH.length} items  OOD holdout: ${OOD_BENCH.length} items`);

const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
if (process.env.OPENAI_API_KEY) opts.apiKey = process.env.OPENAI_API_KEY;

const dt = new Deepthink(model, [], opts);

(async () => {
  try {
    const r = await evolvePrompts(dt.callChat.bind(dt), {
      popSize,
      generations,
      bench: BENCH,
      oodBench: OOD_BENCH,
      runId: undefined,
      dataDir: undefined
    });
    console.log('\n[evolve] done');
    console.log(`[evolve] best: ${r.best.id} fitness=${r.best.fitness.toFixed(3)} op=${r.best.operator}`);
    if (r.oodScore != null) {
      const gap = (r.best.fitness || 0) - r.oodScore;
      console.log(`[evolve] OOD: ${r.oodScore.toFixed(3)}  gap: ${gap.toFixed(3)}${gap > 0.20 ? '  ⚠ overfit' : '  ✓ generalizes'}`);
    }
    console.log(`[evolve] log: ${r.runDir}`);
  } catch (e) {
    console.error('[evolve] FAIL:', e.message);
    process.exit(1);
  }
})();
