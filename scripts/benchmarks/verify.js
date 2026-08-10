// scripts/benchmarks/verify.js
// sympy-backed math equivalence check. exposed as a function so the
// benchmark runner can call it per row.
//
//   verify({ row, model_answer }) -> { ok, reason }
//
//   row.kind   'math-aime' | 'math-proof' | 'int-definite' | 'int-indefinite'
//   row.answer  the gold answer (sympy-parseable string)
//   row.verify  optional extra dispatch for integration-bee rows
//   row.keywords (only for math-proof / IMO) — model answer must mention at
//               least one of these terms to count as correct
//   row.integrand + row.lo + row.hi (int-definite) or row.integrand (int-indefinite)
//
// the python snippet we ship to sympy is built carefully — we never
// interpolate model-controlled strings into a `python -c` invocation
// directly. instead we pass them as base64-encoded argv and read them
// with `sys.argv` inside the snippet.

import { spawnSync } from 'child_process';
import fs from 'node:fs';

const PY = process.env.PYTHON || 'python';

function runPython(script, args = []) {
  const r = spawnSync(PY, ['-c', script, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, reason: `python exit ${r.status}: ${(r.stderr || '').slice(0, 400)}` };
  }
  const out = (r.stdout || '').trim();
  try {
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, reason: `python returned non-json: ${out.slice(0, 200)}` };
  }
}

function b64(s) {
  return Buffer.from(String(s), 'utf-8').toString('base64');
}

// one script per row kind. we keep them tiny and pass arguments as
// base64 to avoid shell-quoting issues on Windows.
const SCRIPT_AIME = `
import sys, json, base64
from sympy import sympify, simplify, nsimplify, Rational
def b64(s): return base64.b64decode(s).decode('utf-8')
def to_n(x):
    try: return Rational(str(x))
    except Exception: return None
try:
    gold = sympify(b64(sys.argv[1]).strip(), evaluate=True)
    pred = sympify(b64(sys.argv[2]).strip(), evaluate=True)
    diff = simplify(pred - gold)
    ok = diff == 0
    if not ok:
        # try rational simplification
        try:
            ok = abs(float(nsimplify(diff))) < 1e-9
        except Exception: pass
    print(json.dumps({'ok': bool(ok), 'reason': str(diff) if not ok else 'exact'}))
except Exception as e:
    print(json.dumps({'ok': False, 'reason': f'parse: {e}'}))
`;

const SCRIPT_INT_DEFINITE = `
import sys, json, base64
from sympy import integrate, sympify, simplify, pi, E, sqrt, Symbol, nsimplify
def b64(s): return base64.b64decode(s).decode('utf-8')
try:
    integrand = b64(sys.argv[1])
    lo = b64(sys.argv[2])
    hi = b64(sys.argv[3])
    pred = b64(sys.argv[4])
    gold = b64(sys.argv[5])
    x = Symbol('x')
    actual = integrate(sympify(integrand), (x, sympify(lo), sympify(hi)))
    expected = sympify(gold)
    diff = simplify(actual - expected)
    print(json.dumps({
      'ok': diff == 0,
      'reason': f'integrate({integrand}) = {actual} (gold {expected})'
    }))
except Exception as e:
    print(json.dumps({'ok': False, 'reason': f'int-def: {e}'}))
`;

const SCRIPT_INT_INDEFINITE = `
import sys, json, base64
from sympy import integrate, sympify, simplify, diff, Symbol
def b64(s): return base64.b64decode(s).decode('utf-8')
try:
    integrand = b64(sys.argv[1])
    pred = b64(sys.argv[2])
    x = Symbol('x')
    # we verify by differentiating the model's answer and checking
    # that we recover the integrand (up to a constant).
    F = sympify(pred)
    dFdx = simplify(diff(F, x))
    expected = sympify(integrand)
    diff_expr = simplify(dFdx - expected)
    print(json.dumps({
      'ok': diff_expr == 0,
      'reason': f"d/dx[{pred}] = {dFdx} (gold {expected})"
    }))
except Exception as e:
    print(json.dumps({'ok': False, 'reason': f'int-indef: {e}'}))
`;

const SCRIPT_PROOF = `
import sys, json, base64
def b64(s): return base64.b64decode(s).decode('utf-8')
try:
    text = b64(sys.argv[1]).lower()
    keywords = json.loads(b64(sys.argv[2]))
    if not keywords:
        print(json.dumps({'ok': False, 'reason': 'no keywords for this row'}))
    else:
        hits = [k for k in keywords if k.lower() in text]
        ok = len(hits) >= 1
        print(json.dumps({
          'ok': ok,
          'reason': f'matched {len(hits)}/{len(keywords)} keywords: {hits}'
        }))
except Exception as e:
    print(json.dumps({'ok': False, 'reason': f'proof: {e}'}))
`;

// strip a model's answer to the bit we care about.
// order: \boxed{...} > \[...\] > [N] > "Final answer:" > last line.
// we always strip outer brackets and trailing punctuation before returning.
function stripBrackets(s) {
  if (!s) return s;
  let t = String(s).trim();
  // \[ ... \]   (latex display brackets)
  t = t.replace(/^\\\[\s*/, '').replace(/\s*\\\]$/, '');
  // [N] / [N].
  t = t.replace(/^\[\s*/, '').replace(/\s*\]\.?$/, '');
  return t.trim();
}

function extractCandidate(modelText) {
  if (!modelText) return '';
  let t = String(modelText);
  // boxed answer wins
  const box = t.match(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
  if (box) return stripBrackets(box[1]);
  // \[...\]  (latex display math)
  const disp = t.match(/\\\[\s*([^\[\]]+?)\s*\\\]/g);
  if (disp) {
    // take the LAST display-math block
    const last = disp[disp.length - 1];
    return stripBrackets(last);
  }
  // [N] anywhere — take the LAST one (final answer)
  const allBrackets = [...t.matchAll(/\[\s*([^\[\]]+?)\s*\]/g)].map((m) => m[1].trim());
  if (allBrackets.length) return stripBrackets(allBrackets[allBrackets.length - 1]);
  // "Final answer:" / "Answer is:" prefix — anchored to line start so
  // "**Verified Answer: 42**" (appended by the pipeline) can't false-match.
  const fa = t.match(/(?:^|\n)\s*(?:final\s*answer|answer\s*(?:is|:))\s*[:=]?\s*([^\n]+)/i);
  if (fa) return stripBrackets(fa[1]);
  // else: last non-empty line, stripped of trailing period
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? stripBrackets(lines[lines.length - 1]) : '';
}

// sympy-ize a string. we do a small pass to handle our model
// tokens: 'pi', 'sqrt', 'atan', 'asin', 'acos', 'log', 'ln', 'e',
// fractions like '1/2'. the verifier scripts run in their own python
// sandbox so this is just sugar.
function normalizeForSympy(s) {
  return s
    .replace(/\\pi/g, 'pi')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\^/g, '**')
    .replace(/\\cdot/g, '*')
    .replace(/\\times/g, '*')
    .replace(/\\ln/g, 'log')
    .replace(/\s+/g, ' ');
}

// last-ditch prose extraction: "the walk takes 2 minutes" -> "2".
// only consulted when the primary candidate fails sympy's parser.
export function extractLastNumber(text) {
  if (!text) return '';
  const m = String(text).match(/-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?/g);
  return m ? m[m.length - 1].trim() : '';
}

// try the primary candidate; if it isn't sympy-parseable, retry with the
// last number buried in the prose (models occasionally skip the format).
function tryWithFallback(run, modelText, norm) {
  let r = run(norm);
  if ((r.reason || '').startsWith('parse:')) {
    const num = normalizeForSympy(extractLastNumber(modelText));
    if (num && num !== norm) r = run(num);
  }
  return r;
}

function verify({ row, modelText }) {
  const cand = extractCandidate(modelText);
  const norm = normalizeForSympy(cand);
  if (row.kind === 'math-aime' || row.kind === 'math-aime-short') {
    if (!norm) return { ok: false, reason: 'no model answer' };
    return tryWithFallback(
      (n) => runPython(SCRIPT_AIME, [b64(row.answer), b64(n)]),
      modelText, norm
    );
  }
  if (row.kind === 'int-definite') {
    if (!norm) return { ok: false, reason: 'no model answer' };
    return tryWithFallback(
      (n) => runPython(SCRIPT_INT_DEFINITE, [
        b64(row.integrand),
        b64(String(row.lo ?? 0)),
        b64(String(row.hi ?? 0)),
        b64(n),
        b64(row.gold || row.answer),
      ]),
      modelText, norm
    );
  }
  if (row.kind === 'int-indefinite') {
    if (!norm) return { ok: false, reason: 'no model answer' };
    return runPython(SCRIPT_INT_INDEFINITE, [
      b64(row.integrand),
      b64(norm),
    ]);
  }
  if (row.kind === 'math-proof') {
    if (row.answer && /^[+-]?\d+$/.test(String(row.answer).trim())) {
      // numeric gold — treat as AIME-style
      if (!norm) return { ok: false, reason: 'no model answer' };
      return runPython(SCRIPT_AIME, [b64(row.answer), b64(norm)]);
    }
    return runPython(SCRIPT_PROOF, [b64(String(modelText || '')), b64(JSON.stringify(row.keywords || []))]);
  }
  return { ok: false, reason: `unknown kind: ${row.kind}` };
}

// CLI: `node verify.js <row.json> <modelAnswer.txt>` for debugging
if (process.argv[1] && process.argv[1].endsWith('verify.js')) {
  const [, , rowPath, txtPath] = process.argv;
  if (!rowPath) {
    console.error('usage: node verify.js <row.json> <modelAnswer.txt>');
    process.exit(2);
  }
  const row = JSON.parse(fs.readFileSync(rowPath, 'utf-8'));
  const text = txtPath
    ? fs.readFileSync(txtPath, 'utf-8')
    : fs.readFileSync(0, 'utf-8');
  const r = verify({ row, modelText: text });
  console.log(JSON.stringify(r, null, 2));
}

export { verify, extractCandidate, normalizeForSympy };
