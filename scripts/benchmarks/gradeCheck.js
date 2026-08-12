// scripts/benchmarks/gradeCheck.js
// re-score a run.js results csv with the CURRENT extractor — parser fixes
// shouldn't invalidate old runs, so this rewrites the ok columns in place.
// (run.js csv format: bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,dt_seconds)
//
// usage: node scripts/benchmarks/gradeCheck.js <set> [--dry]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.resolve(__dirname, '..', '..', 'benchmarks', 'results');
const SET = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!SET) { console.error('usage: node scripts/benchmarks/gradeCheck.js <set> [--dry]'); process.exit(1); }

const CSV = path.join(RES, SET + '.csv');
if (!fs.existsSync(CSV)) { console.error('no such csv:', CSV); process.exit(1); }

// ---- exact copy of run.js extractAnswer + norm + eq ----
function extractAnswer(text) {
  if (!text) return '';
  const t = String(text);
  const box = t.match(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
  if (box) return box[1].trim();
  const tail = t.match(/(?:final\s*answer|answer\s*(?:is|:))\s*[:=]?\s*([^.\n]+)/i);
  if (tail) {
    const cap = tail[1].trim();
    const unwrap = cap.match(/^\[([^\]]+)\]$/);
    if (unwrap) return unwrap[1].trim();
    const chain = cap.match(/(?:=|\b)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)\s*$/);
    if (chain) return chain[1];
    return cap;
  }
  const nums = t.match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g);
  if (nums && nums.length) return nums[nums.length - 1];
  return t.trim();
}

function norm(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).trim();
  t = t.replace(/[$,\s\\[\]{}]/g, '').replace(/^0+(?=\d)/, '');
  return t.toLowerCase();
}

function eq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const fa = parseFloat(na);
  const fb = parseFloat(nb);
  if (!isNaN(fa) && !isNaN(fb) && Math.abs(fa - fb) < 1e-6) return true;
  const fa2 = na.split('/');
  const fb2 = nb.split('/');
  if (fa2.length === 2 && fb2.length === 2) {
    const v = parseFloat(fa2[0]) / parseFloat(fa2[1]) - parseFloat(fb2[0]) / parseFloat(fb2[1]);
    if (!isNaN(v) && Math.abs(v) < 1e-6) return true;
  }
  return false;
}

// ---- csv io (quote-aware) ----
function parseCsv(s) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const t = String(s).replace(/\r?\n/g, ' ').slice(0, 2000);
  if (t.includes(',') || t.includes('"')) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf-8'));
const out = [rows[0].join(',')];
let changed = 0, pOk = 0, dOk = 0, n = 0;
for (const r of rows.slice(1)) {
  if (!r.length || (r.length === 1 && !r[0].trim())) continue;
  const [bench, id, gold, plainA, , dtA, , dtSec] = r;
  const pNew = eq(extractAnswer(plainA), gold) ? '1' : '0';
  const dNew = eq(extractAnswer(dtA), gold) ? '1' : '0';
  if (pNew !== r[4]) changed++;
  if (dNew !== r[6]) changed++;
  if (pNew === '1') pOk++;
  if (dNew === '1') dOk++;
  n++;
  if (DRY) {
    if (dNew === '1' && r[6] !== '1') console.log(`[${SET}] ${id}: dt NOW OK (was X) extract=${JSON.stringify(extractAnswer(dtA).slice(0, 30))} gold=${gold}`);
    if (dNew === '0' && r[6] === '1') console.log(`[${SET}] ${id}: dt NOW X (was OK) extract=${JSON.stringify(extractAnswer(dtA).slice(0, 30))} gold=${gold}`);
  }
  out.push([bench, id, csvEscape(gold), csvEscape(plainA), pNew, csvEscape(dtA), dNew, dtSec].join(','));
}
if (!DRY) fs.writeFileSync(CSV, out.join('\n') + '\n', 'utf-8');
console.log(`[${SET}] ${n} rows — plain ${pOk}/${n} (${(pOk / n * 100).toFixed(1)}%)  dt ${dOk}/${n} (${(dOk / n * 100).toFixed(1)}%)  delta ${(dOk - pOk) >= 0 ? '+' : ''}${(dOk - pOk)}  ${changed} cells changed${DRY ? ' (dry)' : ''}`);
