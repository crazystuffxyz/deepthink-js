// scripts/evalSymbolic.test.js
// regression test for the symbolic-expression evaluator used by the
// Putnam scorers. run: node scripts/evalSymbolic.test.js
// (kept as a file — heredocs mangle backslashes on this box)

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

const cases = [
  ['frac dt form', '\\frac{1 - e^{-2}}{2}', 0.4323, true],
  ['frac plain form', '\\frac{1}{2}(1 - e^{-2})', 0.4323, true],
  ['plain parens', '1/2(1 - e^-2)', 0.4323, true],
  ['trailing chain', '(1 - e^-2)/2', 0.4323, true],
  ['1/pi', '\\frac{1}{\\pi}', 0.3183, true],
  ['neg half', '-1/2', -0.5, true],
  ['neg frac', '-\\frac{1}{2}', -0.5, true],
  ['no expr', 'the answer is clearly not here', 0.4323, false],
  ['wrong value', '(1 - e^-2)', 0.4323, false],
  ['long prose with expr', 'We compute the limit and find that \\frac{1 - e^{-2}}{2} is the final value, which completes the proof.', 0.4323, true],
  ['nested frac', '\\frac{\\frac{1}{2}}{3}', 1 / 6, true],
  ['sqrt form', '\\frac{\\sqrt{2}}{2}', 0.7071, true],
];

let pass = 0;
for (const [name, input, ref, want] of cases) {
  const got = evalSymbolic(input, ref, 0.01);
  const ok = got === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${got} (want ${want})`);
}
console.log(`\n${pass}/${cases.length} cases pass`);
process.exit(pass === cases.length ? 0 : 1);
