// scripts/benchmarks/regrade.js
// re-grade the latest run.js results.csv against the CURRENT usamo-2024.jsonl
// golds (real answers, incl. the newly-found P6 value) using the fixed eq()
// and the same llmJudge. only grades the usamo bench. prints the corrected
// per-row + summary. does not rewrite the csv (keeps raw answers intact).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'gemma4:31b-cloud';
const CSV = path.resolve(__dirname, '..', '..', 'benchmarks', 'results.csv');
const JSONL = path.resolve(__dirname, '..', '..', 'benchmarks', 'data', 'usamo-2024.jsonl');

const golds = Object.fromEntries(fs.readFileSync(JSONL, 'utf-8').split('\n').filter(Boolean).map(l => { const d = JSON.parse(l); return [d.id, d.answer]; }));

function norm(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).trim();
  t = t.replace(/\band\b/gi, '');
  t = t.replace(/[$,\s\\[\]{}]/g, '').replace(/^0+(?=\d)/, '');
  return t.toLowerCase();
}
function numEval(s) {
  let t = String(s).toLowerCase().replace(/√/g, 'sqrt');
  t = t.replace(/−/g, '-').replace(/·/g, '*');
  t = t.replace(/(\d)sqrt/g, '$1*sqrt');
  t = t.replace(/sqrt(\d+)/g, 'Math.sqrt($1)');
  t = t.replace(/(\d)π/g, '$1*Math.PI').replace(/π/g, 'Math.PI');
  if (!/^[\d\s+\-*/().a-zA-Z]+$/.test(t)) return NaN;
  try { const v = Function('return (' + t + ')')(); return typeof v === 'number' && isFinite(v) ? v : NaN; } catch { return NaN; }
}
function isPlainNum(s) { return /^-?\d+(?:\.\d+)?(?:\/\d+)?$/.test(s); }
function eq(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  if (isPlainNum(na) && isPlainNum(nb)) {
    const fa = parseFloat(na), fb = parseFloat(nb);
    if (Math.abs(fa - fb) < 1e-6 || Math.abs(fa - fb) / Math.max(Math.abs(fa), Math.abs(fb), 1) < 1e-4) return true;
  }
  const fa2 = na.split('/'), fb2 = nb.split('/');
  if (fa2.length === 2 && fb2.length === 2) {
    const v = parseFloat(fa2[0]) / parseFloat(fa2[1]) - parseFloat(fb2[0]) / parseFloat(fb2[1]);
    if (!isNaN(v) && Math.abs(v) < 1e-6) return true;
  }
  const va = numEval(na), vb = numEval(nb);
  if (!isNaN(va) && !isNaN(vb) && Math.abs(va - vb) < 1e-6) return true;
  return false;
}

function parseCsv(s) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function llmJudge(client, gold, predicted) {
  if (!predicted) return 0;
  if (gold && eq(predicted, gold)) return 1;
  if (!gold || !gold.trim()) return 0; // no key, no credit (real answers exist now)
  const judgePrompt = `You are comparing a student's answer to an official answer key for a math competition problem. You are NOT solving the problem — only judging whether the two statements express the same mathematical answer.

OFFICIAL ANSWER KEY: ${gold}
STUDENT ANSWER: ${predicted}

Judge whether the student's answer is mathematically equivalent to the official answer. They may use different words or notation (e.g. "3 and 4" vs "3,4", or "\\sqrt{270}" vs "3\\sqrt{30}") but must express the same truth. A subset of the answer (e.g. only one value when the key lists several) is NOT equivalent.

Output ONLY "YES" if equivalent or "NO" if different.`;
  try {
    const r = await client.chat({ model: MODEL, messages: [{ role: 'user', content: judgePrompt }], stream: false });
    return String(r.content || '').trim().toUpperCase().includes('YES') ? 1 : 0;
  } catch { return 0; }
}

const dt = new Deepthink(MODEL, [], { provider: 'ollama' }, Infinity, null, { maxConcurrency: 6 });
const plain = dt.buildClient(null);

const rows = parseCsv(fs.readFileSync(CSV, 'utf-8'));
let pOk = 0, dOk = 0, n = 0;
console.log('per-problem regrade:');
for (const r of rows.slice(1)) {
  if (r[0] !== 'usamo-2024') continue;
  const gold = golds[r[1]] || '';
  const pNew = (gold && eq(r[3], gold)) ? 1 : await llmJudge(plain, gold, r[3]);
  const dNew = (gold && eq(r[5], gold)) ? 1 : await llmJudge(plain, gold, r[5]);
  pOk += pNew; dOk += dNew; n++;
  console.log(`  ${r[1]}: gold="${gold.slice(0,30)}"  plain=${pNew ? 'OK' : 'X'} (${r[3].slice(0,28)})  dt=${dNew ? 'OK' : 'X'} (${r[5].slice(0,28)})`);
}
console.log(`\n=== regraded: plain ${pOk}/${n} (${(pOk/n*100).toFixed(1)}%)  dt ${dOk}/${n} (${(dOk/n*100).toFixed(1)}%)  delta ${((dOk-pOk)/n*100).toFixed(1)}pp`);
dt.destroy();
