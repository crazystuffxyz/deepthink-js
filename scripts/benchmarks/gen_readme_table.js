// scripts/benchmarks/gen_readme_table.js
// read benchmarks/results.csv + summary.json and print a markdown table
// for the README. meant to be invoked after a benchmark run.
//
// usage:  node scripts/benchmarks/gen_readme_table.js [csv-path] [summary-path]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] || path.resolve(__dirname, '..', '..', 'benchmarks', 'results.csv');
const sumPath = process.argv[3] || csvPath.replace(/\.csv$/, '.summary.json');

if (!fs.existsSync(sumPath)) {
  console.error(`missing ${sumPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(sumPath, 'utf-8'));
const lines = [];

lines.push('| Benchmark | Source | n | Plain | Deepthink (d=' + summary.depth + ', c=' + summary.checks + ') | Δ |');
lines.push('|---|---|---:|---:|---:|---:|');

const labels = {
  aime2024: ['AIME 2024', 'Maxwell-Jia/AIME_2024', 'https://huggingface.co/datasets/Maxwell-Jia/AIME_2024'],
  gsm8k: ['GSM8K', 'openai/grade-school-math', 'https://github.com/openai/grade-school-math'],
  math500: ['MATH-500', 'HuggingFaceH4/MATH-500', 'https://huggingface.co/datasets/HuggingFaceH4/MATH-500'],
};

for (const r of summary.rows) {
  const [name, src, srcUrl] = labels[r.bench] || [r.bench, r.bench, ''];
  const p = (r.plain * 100).toFixed(1);
  const d = (r.dt * 100).toFixed(1);
  const delta = r.delta * 100;
  const sign = delta >= 0 ? '+' : '';
  const srcCell = srcUrl ? `[${src}](${srcUrl})` : src;
  lines.push(`| ${name} | ${srcCell} | ${r.total} | ${p}% | ${d}% | ${sign}${delta.toFixed(1)}pp |`);
}

const out = lines.join('\n') + '\n';
console.log(out);

// write the same table to a sibling file
const tblPath = csvPath.replace(/\.csv$/, '.table.md');
fs.writeFileSync(tblPath, out);
console.log(`wrote ${tblPath}`);
