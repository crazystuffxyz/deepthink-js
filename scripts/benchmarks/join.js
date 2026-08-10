// scripts/benchmarks/join.js
// merge per-bench csv files (results_aime.csv, results_gsm8k.csv,
// results_math500.csv) into a single results.csv + summary.json.
// also regenerates the README table from gen_readme_table.js
//
// usage:  node scripts/benchmarks/join.js

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', 'benchmarks');

const parts = ['results_aime.csv', 'results_gsm8k.csv', 'results_math500.csv']
  .map((p) => path.join(root, p))
  .filter((p) => fs.existsSync(p));

if (!parts.length) {
  console.error('no per-bench csv files found');
  process.exit(1);
}

const outCsv = path.join(root, 'results.csv');
const header = 'bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,dt_seconds\n';
const out = fs.openSync(outCsv, 'w');
fs.writeSync(out, header);

const summary = { model: 'gemma4:31b-cloud', depth: 3, checks: 2, rows: [] };
const benchCounts = {};

for (const p of parts) {
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  const bench = path.basename(p, '.csv').replace(/^results_/, '');
  let pN = 0, dN = 0, n = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    // bench is the first cell — but parts are already per-bench so trust filename
    fs.writeSync(out, lines[i] + '\n');
    const plainOk = parseInt(cells[4], 10) || 0;
    const dtOk = parseInt(cells[6], 10) || 0;
    pN += plainOk;
    dN += dtOk;
    n++;
  }
  summary.rows.push({
    bench,
    total: n,
    plain: pN / (n || 1),
    dt: dN / (n || 1),
    delta: dN / (n || 1) - pN / (n || 1),
  });
  benchCounts[bench] = n;
}

fs.closeSync(out);
fs.writeFileSync(path.join(root, 'results.summary.json'), JSON.stringify(summary, null, 2));

console.log('joined:', benchCounts);
console.log('wrote', outCsv);
console.log('wrote', path.join(root, 'results.summary.json'));

// regenerate the README table
try {
  execSync(`node "${path.join(__dirname, 'gen_readme_table.js')}" "${outCsv}"`, { stdio: 'inherit' });
} catch (e) {
  console.error('table gen failed:', e.message);
}
