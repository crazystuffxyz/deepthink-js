// scripts/benchmarks/latency.js — wall-clock + token benchmark on the default
// model. measures a bare chat call vs deepthink at two effort presets across
// a fixed 6-question set, reports p50/p90 and tokens/s per mode.
//
//   node scripts/benchmarks/latency.js            # default model
//   BENCH_MODEL=llama3.1 node scripts/benchmarks/latency.js
//   node scripts/benchmarks/latency.js --write    # also write the summary json
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import Deepthink from '../../dist/index.js';

const MODEL = process.env.BENCH_MODEL || 'gemma4:31b-cloud';
const WRITE = process.argv.includes('--write');

const QUESTIONS = [
  'What is the capital of Peru? Answer with just the city name.',
  'What is 12.5% of 640? Answer with just the number.',
  'Name the smallest prime greater than 100. Answer with just the number.',
  'What year did the Berlin Wall fall? Answer with just the year.',
  'What is the chemical symbol for potassium? Answer with just the symbol.',
  'How many bones are in the adult human body? Answer with just the number.',
];

const MODES = [
  { name: 'plain', opts: null },
  { name: 'dt:d1c0', opts: { depth: 1, checks: 0, mcts: false, enableCode: false } },
  { name: 'dt:d2c1', opts: { depth: 2, checks: 1, mcts: true, enableCode: false } },
];

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const dt = new Deepthink(MODEL, [], { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' });
if (process.env.OLLAMA_HOST) console.log(`[latency] OLLAMA_HOST=${process.env.OLLAMA_HOST}`);
console.log(`[latency] model=${MODEL} questions=${QUESTIONS.length} modes=${MODES.map(m => m.name).join(', ')}`);

const rows = [];
for (const mode of MODES) {
  const ms = [];
  let failed = 0;
  for (let i = 0; i < QUESTIONS.length; i++) {
    const t0 = Date.now();
    try {
      if (mode.opts) await dt.generate(QUESTIONS[i], { ...mode.opts, type: 'string', autoSystemPrompt: true });
      else await dt.callChat([{ role: 'user', content: QUESTIONS[i] }], false, null, { autoSystemPrompt: false });
      const el = Date.now() - t0;
      ms.push(el);
      console.log(`  ${mode.name}  q${i + 1}: ${el}ms`);
    } catch (e) {
      failed++;
      console.log(`  ${mode.name}  q${i + 1}: FAILED ${String(e.message).slice(0, 80)}`);
    }
  }
  rows.push({ mode: mode.name, n: ms.length, failed, p50: Math.round(percentile(ms, 50)), p90: Math.round(percentile(ms, 90)), mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0 });
}

console.log('\n| mode | n | p50 ms | p90 ms | mean ms |');
console.log('|---|---:|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.mode} | ${r.n} | ${r.p50} | ${r.p90} | ${r.mean} |`);

if (WRITE) {
  const out = path.resolve('benchmarks/results/latency.summary.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, ts: new Date().toISOString(), rows }, null, 2));
  console.log(`[latency] wrote ${out}`);
}