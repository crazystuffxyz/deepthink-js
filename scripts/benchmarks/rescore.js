// scripts/benchmarks/rescore.js
// re-score an existing results csv with the CURRENT parser — parser fixes
// shouldn't invalidate old runs, so this rewrites ok/answer columns in place.
//
// usage: node scripts/benchmarks/rescore.js <set> [--dry]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseAnswer, answersMatch } from './parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.resolve(__dirname, '..', '..', 'benchmarks', 'results');
const SET = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!SET) { console.error('usage: node scripts/benchmarks/rescore.js <set> [--dry]'); process.exit(1); }

const CSV = path.join(RES, SET + '.csv');
if (!fs.existsSync(CSV)) { console.error('no such csv:', CSV); process.exit(1); }

// csv rows: id,kind,mode,answer,gold,ok,ms,tokens,calls,raw
// raw may contain commas (quoted) — split on the 9th comma only
function splitRow(l) {
  const parts = [];
  let cur = '', inQ = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inQ) {
      if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

const lines = fs.readFileSync(CSV, 'utf-8').split('\n');
const header = lines[0];
const out = [header];
let changed = 0, ok = 0, n = 0;
for (const l of lines.slice(1)) {
  if (!l.trim()) continue;
  const c = splitRow(l);
  const [id, kind, mode, , gold, , ms, tokens, calls, raw] = c;
  const cands = parseAnswer(raw);
  const match = answersMatch(cands, gold);
  const newOk = match ? '1' : '0';
  if (newOk !== c[5]) changed++;
  if (newOk === '1') ok++;
  n++;
  if (DRY) {
    if (newOk === '1' && c[5] !== '1') console.log(`[${SET}] ${id} ${mode}: NOW OK (was X) got=${cands[0] ?? ''} gold=${gold}`);
    if (newOk === '0' && c[5] === '1') console.log(`[${SET}] ${id} ${mode}: NOW X (was OK) got=${cands[0] ?? ''} gold=${gold}`);
  }
  c[3] = cands[0] ?? '';
  c[5] = newOk;
  out.push(c.join(','));
}
if (!DRY) fs.writeFileSync(CSV, out.join('\n'), 'utf-8');
console.log(`[${SET}] ${n} rows, ${ok} ok (${(ok / n * 100).toFixed(1)}%), ${changed} changed${DRY ? ' (dry)' : ''}`);
