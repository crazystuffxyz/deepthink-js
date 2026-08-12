// scripts/rescorePutnam.js
// re-score saved putnam-diag outputs with the CURRENT scorer (no model
// calls — the outputs are already on disk). run after scorer fixes:
//   node scripts/rescorePutnam.js
// reads benchmarks/results/putnam-diag/p20{24,25}-*.json, prints the table.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'benchmarks', 'results', 'putnam-diag');

// ---- scoring (same semantics as putnamDiag.js scoreOne)
function norm(t) { return String(t || '').trim(); }

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

const files = fs.readdirSync(OUT).filter((f) => /^p20(24|25)-.*\.json$/.test(f)).sort();
const bySet = {};
for (const f of files) {
  const row = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8'));
  const set = f.startsWith('p2024') ? '2024' : '2025';
  (bySet[set] ||= []).push(row);
}

for (const [set, rows] of Object.entries(bySet)) {
  let pOk = 0, dOk = 0;
  console.log(`\n=== Putnam ${set} (re-scored with fixed evalSymbolic) ===`);
  for (const r of rows) {
    // saved ref is the display form: array refs were joined with " | "
    const answer = r.kind === 'deduction' && String(r.ref).includes(' | ')
      ? String(r.ref).split(' | ')
      : r.ref;
    const ps = scoreOne({ id: r.id, kind: r.kind, answer }, r.plain.output);
    const ds = scoreOne({ id: r.id, kind: r.kind, answer }, r.dt.output);
    pOk += ps.ok; dOk += ds.ok;
    const flip = ps.ok !== r.plain.ok || ds.ok !== r.dt.ok ? '  ← CHANGED' : '';
    console.log(`  [${r.id}] plain ${ps.ok ? 'OK' : 'X'} | dt ${ds.ok ? 'OK' : 'X'} | ref=${JSON.stringify(r.ref)}${flip}`);
  }
  console.log(`  → plain ${pOk}/${rows.length} | dt ${dOk}/${rows.length}`);
}
