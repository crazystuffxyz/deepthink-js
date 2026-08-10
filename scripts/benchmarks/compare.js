// scripts/benchmarks/compare.js
// side-by-side old-pipeline vs new-pipeline benchmark results.
//
//   node scripts/benchmarks/compare.js [old.csv] [new.csv]
//
// defaults: benchmarks/results/snapshot-baseline-old/all.csv (old pipeline,
// AIME section ran on corrupted data — flagged) vs benchmarks/results/all.csv
// (current pipeline, clean data). prints a per-plan table: plain/dt accuracy
// + call/token/revision medians for each side, plus a verdict line per plan.
//
// usage for the report: run after the new benchmark completes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const OLD = process.argv[2] || path.join(ROOT, 'results', 'snapshot-baseline-old', 'all.csv');
const NEW = process.argv[3] || path.join(ROOT, 'results', 'all.csv');

// all.csv columns (see all.js): 0 bench, 1 id, 2 gold, 3 plain_answer,
// 4 plain_correct, 5 dt_answer, 6 dt_correct, 7/8 codeexec_ok,
// 9/10 plain_s/dt_s, 11 dt_calls, 12 dt_tok_in, 13 dt_tok_out,
// 14 dt_llm_s, 15 dt_errors, 16 dt_checks, 17 dt_revisions,
// 18 dt_revised, 19 dt_corrected
// quote-aware split — answer fields are prose with commas inside quotes
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readRows(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(parseCsvLine)
    .filter((c) => c.length >= 2 && c[0] !== 'bench');
}

function agg(rows, bench) {
  const rs = rows.filter((r) => r[0] === bench);
  const med = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  return {
    n: rs.length,
    pOk: rs.filter((r) => r[4] === '1').length,
    dOk: rs.filter((r) => r[6] === '1').length,
    dCalls: med(rs.map((r) => Number(r[11]))),
    dTok: med(rs.map((r) => Number(r[12]) + Number(r[13]))),
    dRev: med(rs.map((r) => Number(r[17]))),
    dCorrected: rs.filter((r) => r[19] === '1').length,
  };
}

const oldRows = readRows(OLD);
const newRows = readRows(NEW);
const benches = [...new Set([...oldRows.map((r) => r[0]), ...newRows.map((r) => r[0])])];

console.log(`old: ${OLD}\nnew: ${NEW}\n`);
console.log('plan             | old plain | old dt | new plain | new dt | dt calls (old→new) | dt k-tok (old→new) | rev (old→new) | self-corr');
console.log('-----------------|-----------|---------|-----------|---------|--------------------|--------------------|---------------|----------');
for (const b of benches) {
  const o = agg(oldRows, b);
  const n = agg(newRows, b);
  const row = `${b.padEnd(16)} | ${(o.pOk + '/' + o.n).padEnd(9)} | ${(o.dOk + '/' + o.n).padEnd(7)} | ${(n.pOk + '/' + n.n).padEnd(9)} | ${(n.dOk + '/' + n.n).padEnd(7)} | ${String(o.dCalls + '→' + n.dCalls).padEnd(18)} | ${String(Math.round(o.dTok / 1000) + '→' + Math.round(n.dTok / 1000) + 'k').padEnd(18)} | ${String(o.dRev + '→' + n.dRev).padEnd(13)} | ${n.dCorrected}/${n.n}`;
  console.log(row);
}
