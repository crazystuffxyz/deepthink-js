// scripts/putnamDiag.js
// one-pass diagnostic: how does deepthink solve Putnam RIGHT NOW vs plain?
// no evolution, no population — just the current framework, one shot each.
//
//   node scripts/putnamDiag.js [--set putnam-2025.jsonl] [--depth 2] [--checks 2]
//
// scoring mirrors evolvedScoring: deduction = conclusion phrase in output,
// math = any number in output matches the key (multi-number style).
// full outputs + traces land in benchmarks/results/putnam-diag/ for
// failure analysis.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink, { TraceStore } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'benchmarks');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'results', 'putnam-diag');
fs.mkdirSync(OUT, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const SET = arg('set', 'putnam-2025.jsonl');
const DEPTH = Number(arg('depth', process.env.BENCH_DEPTH || '2'));
const CHECKS = Number(arg('checks', process.env.BENCH_CHECKS || '2'));
const CONCURRENCY = Number(arg('concurrency', process.env.BENCH_CONCURRENCY || '2'));

const items = fs.readFileSync(path.join(DATA, SET), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- scoring (same semantics as evolvedScoring)
function norm(t) { return String(t || '').trim(); }

// models answer Putnam problems in LaTeX — \frac{1}{\pi} never contains the
// literal "1/π" the key uses. normalize math notation to plain text before
// matching: \frac{a}{b} → a/b, \pi → π, x_1 → x1, drop $ { } \left \right.
function normalizeMath(s) {
  let t = String(s || '');
  for (let i = 0; i < 3; i++) {
    const n = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => `${a}/${b}`);
    if (n === t) break;
    t = n;
  }
  return t
    .replace(/\\pi\b/g, 'π')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\times\b/g, '×')
    .replace(/\\pm\b/g, '±')
    .replace(/\\le\b|\\leq\b|\\leqslant\b/g, '≤')
    .replace(/\\ge\b|\\geq\b|\\geqslant\b/g, '≥')
    .replace(/\\ne\b|\\neq\b/g, '≠')
    .replace(/\\infty\b/g, '∞')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\\ldots\b|\\dots\b|\\cdots\b/g, '...')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\left\b|\\right\b/g, '')
    .replace(/\\quad\b|\\qquad\b/g, ' ')
    .replace(/\\,/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\[a-zA-Z]+\b/g, '')
    .replace(/[{}$]/g, '')
    .replace(/_/g, '')
    .replace(/\s+/g, ' ');
}
// \frac{a}{b} → (a)/(b) with a balanced-brace scan — the regex form dies on
// nested braces (\frac{1 - e^{-2}}{2} has e^{-2} inside the numerator).
function fracToParens(s) {
  function readBalanced(start) {
    let d = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') { d--; if (d === 0) return { body: s.slice(start + 1, i), end: i }; }
    }
    return null;
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('\\frac{', i)) {
      const a = readBalanced(i + 5); // the { of \frac{ sits at i+5
      if (a && s[a.end + 1] === '{') {
        const b = readBalanced(a.end + 1);
        if (b) { out += `(${a.body})/(${b.body})`; i = b.end; continue; }
      }
    }
    out += s[i];
  }
  return out;
}

// symbolic answers: the model writes (1 - e^{-2})/2, never 0.4323. evaluate
// balanced-paren expressions (plus trailing operator chains) numerically and
// compare against the reference. safe scope: Math only, no globals.
function evalSymbolic(t, ref, tol) {
  // evaluation-specific normalization: \frac{a}{b} → (a)/(b) — parens matter
  // for arithmetic ((1 - e^{-2})/2 ≠ 1 - e^{-2}/2). phrase matching uses the
  // paren-free form; evaluation needs the parens.
  let s = fracToParens(String(t || ''));
  s = normalizeMath(s);
  const groups = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '(') continue;
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '(') d++;
      else if (s[j] === ')') { d--; if (d === 0) { groups.push({ start: i, end: j }); break; } }
    }
  }
  const cands = [];
  for (const g of groups) {
    // maximal span: extend left/right through math tokens (parens included)
    // so implicit multiplication (1/2(1 - e^-2)), trailing chains
    // ((1 - e^-2)/2) and paren denominators ((1 - e^-2)/(2)) all evaluate.
    let a = g.start, b = g.end;
    while (a > 0 && /[0-9πe.\-*/^()]/.test(s[a - 1])) a--;
    while (b < s.length - 1 && /[0-9πe.\-*/^()]/.test(s[b + 1])) b++;
    cands.push(s.slice(a, b + 1));
  }
  // bare answers with no parens at all (-1/2, 1/π → no group): try the
  // whole normalized text when it's short enough to be a standalone answer.
  if (s.length <= 80 && /\d/.test(s)) cands.push(s);
  for (const span of cands) {
    if (!/\d/.test(span)) continue;
    const js = span
      .replace(/\)\s*\(/g, ')*(')
      .replace(/\)\s*(\d|π)/g, ')*$1')
      .replace(/(\d|π)\s*\(/g, '$1*(')
      .replace(/e\^-?\d+/g, (mm) => 'Math.exp(' + mm.slice(2) + ')')
      .replace(/sqrt\(/g, 'Math.sqrt(')
      .replace(/π/g, 'Math.PI')
      .replace(/\^/g, '**');
    try {
      const v = Function('Math', 'return (' + js + ')')(Math);
      if (typeof v === 'number' && isFinite(v)) {
        if (ref === 0 ? Math.abs(v) <= tol : Math.abs(v - ref) / Math.abs(ref) <= tol) return true;
      }
    } catch { /* not an expression */ }
  }
  return false;
}

function scoreOne(item, text) {
  // space-insensitive: "n^2 + n" must match ref "n^2+n"
  const t = normalizeMath(norm(text)).toLowerCase().replace(/\s+/g, '');
  if (item.kind === 'deduction') {
    // array answer = any acceptable phrasing ("x1 < x2" or its mirror "x2 > x1")
    const refs = Array.isArray(item.answer) ? item.answer : [item.answer];
    const ref = refs.map((r) => String(r).toLowerCase().replace(/\s+/g, ''));
    return { ok: ref.some((r) => t.includes(r)) ? 1 : 0, ref: refs.join(' | ') };
  }
  // math: any number in the output matches the key (multi-number style);
  // fall back to symbolic evaluation for exact forms like (1 - e^{-2})/2.
  const ref = typeof item.answer === 'object' ? item.answer.a0 : Number(item.answer);
  const nums = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const tol = 0.01;
  let ok = nums.some((v) => (ref === 0 ? Math.abs(v) <= tol : Math.abs(v - ref) / Math.abs(ref) <= tol)) ? 1 : 0;
  if (!ok && evalSymbolic(text, ref, tol)) ok = 1;
  return { ok, ref, nums };
}

async function withRetry(fn, label, attempts = 5, timeoutMs = 15 * 60_000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
      ]);
    } catch (e) {
      lastErr = e;
      const wait = 1000 * Math.pow(2, i);
      console.log(`    [retry ${i + 1}/${attempts}] ${label}: ${String(e.message || e).slice(0, 100)} (wait ${wait}ms)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const queue = new PQueue({ concurrency: CONCURRENCY });
const dt = new Deepthink(MODEL, [], { provider: 'ollama' }, Infinity, 'deepseek-v4-flash:0731-cloud', {
  adaptiveConcurrency: true,
  traceMode: 'flat',
});
const plain = dt.buildClient(null);

(async () => {
  const t0 = Date.now();
  const rows = [];
  let pOk = 0, dOk = 0;
  console.log(`[putnamDiag] ${SET} — ${items.length} items, plain vs dt (d=${DEPTH} c=${CHECKS}), model=${MODEL}`);

  await queue.addAll(items.map((item) => async () => {
    const myTrace = new TraceStore('flat', 500);
    let plainA = '', dtA = '', pSec = 0, dSec = 0, pErr = '', dErr = '';
    try {
      const t1 = Date.now();
      const r = await withRetry(() => plain.chat({
        model: MODEL,
        messages: [{ role: 'user', content: item.problem }],
        stream: false,
      }), 'plain');
      plainA = (r && r.content) || '';
      pSec = (Date.now() - t1) / 1000;
    } catch (e) { pErr = String(e.message || e); }
    try {
      const t2 = Date.now();
      const r = await withRetry(() => dt.generate(item.problem, {
        depth: DEPTH, checks: CHECKS, checkStyle: 'full', _trace: myTrace,
      }), 'dt');
      dtA = typeof r === 'string' ? r : (r && (r.answer || r.output || r.content || r.text || r.result)) || '';
      dSec = (Date.now() - t2) / 1000;
    } catch (e) { dErr = String(e.message || e); }

    const ps = scoreOne(item, plainA);
    const ds = scoreOne(item, dtA);
    pOk += ps.ok; dOk += ds.ok;
    const row = {
      id: item.id, kind: item.kind, ref: ps.ref,
      plain: { ok: ps.ok, sec: pSec, err: pErr, output: plainA },
      dt: { ok: ds.ok, sec: dSec, err: dErr, output: dtA, trace: myTrace.toJSON() },
    };
    rows.push(row);
    fs.writeFileSync(path.join(OUT, `${item.id}.json`), JSON.stringify(row, null, 2), 'utf-8');
    console.log(`  [${item.id}] plain ${ps.ok ? 'OK' : 'X'} (${pSec.toFixed(0)}s) | dt ${ds.ok ? 'OK' : 'X'} (${dSec.toFixed(0)}s) | ref=${JSON.stringify(ps.ref)}`);
  }));

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
    set: SET, model: MODEL, depth: DEPTH, checks: CHECKS,
    plain: { ok: pOk, total: items.length },
    dt: { ok: dOk, total: items.length },
    rows: rows.map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, plainOk: r.plain.ok, dtOk: r.dt.ok, plainSec: r.plain.sec, dtSec: r.dt.sec })),
  }, null, 2), 'utf-8');

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n[putnamDiag] done in ${mins} min`);
  console.log(`[putnamDiag] plain ${pOk}/${items.length} | dt ${dOk}/${items.length}`);
  console.log(`[putnamDiag] saved ${OUT}`);
  dt.destroy();
  process.exit(0);
})().catch((e) => { console.error('[putnamDiag] fatal:', e); process.exit(1); });
