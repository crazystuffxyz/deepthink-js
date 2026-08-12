// thinking/evolvedScoring.ts
import { numericScore } from './benchmarkSet.js';
import { stripCodeFences, stripThinkBlocks, parseDataType, extractJSON } from './dataTypes.js';
import { runPythonSandbox } from '../codeGenerator/index.js';

type BenchItem = { id: string; kind: string; prompt: string; reference?: unknown; numericTolerance?: number; weight?: number; rubric?: Record<string, number> };
type CallChat = (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;
type ChatMessage = { role: string; content: string };

function norm(text: string): string {
  return stripCodeFences(stripThinkBlocks(String(text || ''))).trim();
}

/** models answer Putnam-style problems in LaTeX — \frac{1}{\pi} never
 *  contains the literal "1/π" the key uses. normalize math notation to
 *  plain text before matching: \frac{a}{b} → a/b, \pi → π, x_1 → x1,
 *  drop $ { } \left \right. */
function normalizeMath(s: string): string {
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

/** \frac{a}{b} → (a)/(b) with a balanced-brace scan — the regex form dies on
 *  nested braces (\frac{1 - e^{-2}}{2} has e^{-2} inside the numerator). */
function fracToParens(s: string): string {
  function readBalanced(start: number): { body: string; end: number } | null {
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

/** symbolic answers: the model writes (1 - e^{-2})/2, never 0.4323. evaluate
 *  balanced-paren expressions (plus trailing operator chains) numerically and
 *  compare against the reference. safe scope: Math only, no globals. */
function evalSymbolic(text: string, ref: number, tol: number): boolean {
  // evaluation-specific normalization: \frac{a}{b} → (a)/(b) — parens matter
  // for arithmetic ((1 - e^{-2})/2 ≠ 1 - e^{-2}/2). phrase matching uses the
  // paren-free form; evaluation needs the parens.
  let s = fracToParens(String(text || ''));
  s = normalizeMath(s);
  const groups: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '(') continue;
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '(') d++;
      else if (s[j] === ')') { d--; if (d === 0) { groups.push({ start: i, end: j }); break; } }
    }
  }
  const cands: string[] = [];
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

function extractNumber(text: string): number {
  const t = norm(text);
  const direct = parseDataType(t, 'double') as number;
  if (typeof direct === 'number' && !isNaN(direct) && isFinite(direct)) return direct;
  const m = t.match(/-?\d+(?:\.\d+)?/g);
  if (!m) return NaN;
  return parseFloat(m[m.length - 1]);
}

function extractProbability(text: string, ref: number): number {
  const t = norm(text).toLowerCase();
  const cleaned = t.replace(/%/g, '');
  const direct = parseDataType(cleaned, 'double') as number;
  if (typeof direct === 'number' && isFinite(direct)) {
    if (ref > 0 && ref < 1 && direct >= 1 && t.includes('%')) {
      return direct / 100;
    }
    return direct;
  }
  return extractNumber(text);
}

function extractAllNumbers(text: string): number[] {
  const t = norm(text);
  const m = t.match(/-?\d+(?:\.\d+)?/g);
  if (!m) return [];
  return m.map(s => parseFloat(s)).filter(x => isFinite(x));
}

function multiNumberScore(text: string, reference: Record<string, number> | number[], tol: number): { score: number; matched: number; total: number } {
  const nums = extractAllNumbers(text);
  let entries: [string, number][] = [];
  if (Array.isArray(reference)) entries = reference.map((v, i) => [`a${i}`, v]);
  else entries = Object.entries(reference);
  if (entries.length === 0 || nums.length === 0) return { score: 0, matched: 0, total: entries.length };
  const used = new Set<number>();
  let matched = 0;
  for (const [, ref] of entries) {
    let bestI = -1, bestRel = Infinity;
    for (let i = 0; i < nums.length; i++) {
      if (used.has(i)) continue;
      const v = nums[i];
      if (typeof ref !== 'number' || !isFinite(ref)) continue;
      const rel = ref === 0 ? Math.abs(v) : Math.abs(v - ref) / Math.abs(ref);
      if (rel < bestRel) { bestRel = rel; bestI = i; }
    }
    if (bestI >= 0 && bestRel <= (tol || 0.05)) {
      matched++;
      used.add(bestI);
    }
  }
  return { score: entries.length ? matched / entries.length : 0, matched, total: entries.length };
}

function extractTime(text: string): { hour: number; minute: number } | null {
  const t = norm(text);
  const m = t.match(/(\d{1,2})[:.](\d{2})/);
  if (m) return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
  return null;
}

async function runPythonIfPresent(text: string): Promise<unknown> {
  const m = text.match(/```python\s*([\s\S]*?)```/i) || text.match(/<code[^>]*>\s*([\s\S]*?)\s*<\/code>/i);
  if (!m) return null;
  try {
    return await runPythonSandbox(m[1].trim());
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function runCodeTests(text: string, item: BenchItem): Promise<{ ran: boolean; passed: number; total: number; fnName?: string; error?: string }> {
  if (!item.reference || !(item.reference as { testCases?: unknown[] }).testCases) return null as unknown as { ran: boolean; passed: number; total: number; fnName?: string; error?: string };
  const ref = item.reference as { testCases: { input: string; expected: unknown }[]; functionName?: string };
  const py = await runPythonIfPresent(text) as { error?: string } | null;
  if (!py) return { ran: false, passed: 0, total: ref.testCases.length, error: 'no code block' };
  if (py.error) return { ran: false, passed: 0, total: ref.testCases.length, error: py.error };

  const fn = text.match(/```python\s*([\s\S]*?)```/i)?.[1]?.trim() || '';
  if (!fn) return { ran: false, passed: 0, total: ref.testCases.length, error: 'no function body' };

  let fnName: string | undefined = ref.functionName;
  if (!fnName) {
    const m = fn.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (m) fnName = m[1];
  }
  if (!fnName) fnName = 'solution';

  const arity = (fn.match(/def\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(([^)]*)\)/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean).length;
  const inputs = ref.testCases.map(tc => {
    if (arity <= 1) {
      const parts = String(tc.input).split(',');
      return parts[0];
    }
    return `(${tc.input})`;
  });

  const harness = ref.testCases.map((tc, i) => {
    const call = arity <= 1 ? `${fnName}(${inputs[i]})` : `${fnName}(${inputs[i].slice(1, -1)})`;
    return `try:\n    got = ${call}\n    ok = (got == ${JSON.stringify(tc.expected)})\n    print(f"tc{i}:{int(ok)}:{got}")\nexcept Exception as e:\n    print(f"tc{i}:0:ERR:{e}")`;
  }).join('\n');

  try {
    const out = await runPythonSandbox(fn + '\n\n' + harness);
    const outText = String(out || '');
    let passed = 0;
    const total = ref.testCases.length;
    for (let i = 0; i < total; i++) {
      if (outText.includes(`tc${i}:1`)) passed++;
    }
    return { ran: true, passed, total, fnName };
  } catch (e) {
    return { ran: false, passed: 0, total: ref.testCases.length, error: (e as Error).message };
  }
}

async function llmJudge(callChat: CallChat, text: string, item: BenchItem, opts: Record<string, unknown>): Promise<{ score: number; breakdown: Record<string, number> | null; reason?: string; raw?: string; error?: string }> {
  if (!item.rubric) return null as unknown as { score: number; breakdown: Record<string, number> | null; reason?: string; raw?: string; error?: string };
  const rubricKeys = Object.keys(item.rubric);
  const rubricText = rubricKeys.map(k => `- ${k}: weight ${item.rubric![k]}`).join('\n');
  const prompt = `You are a strict grader. Score the following response on these dimensions, each 0-1.

${rubricText}

Output ONLY valid JSON of this exact form:
{${rubricKeys.map(k => `"${k}": 0.0`).join(', ')}, "reason": "one short sentence"}

Response to grade:
"""${text.slice(0, 4000)}"""
`;
  const r = await callChat(
    [{ role: 'system', content: 'You grade responses. Be strict. Output strict JSON only.' },
     { role: 'user', content: prompt }],
    false, null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'verify', temperature: 0 }
  );
  try {
    const j = extractJSON(r.content || '{}') as Record<string, unknown>;
    let score = 0;
    for (const k of rubricKeys) {
      const v = Math.max(0, Math.min(1, Number(j[k]) || 0));
      score += v * item.rubric![k];
    }
    return { score: Math.max(0, Math.min(1, score)), breakdown: j as Record<string, number>, reason: j.reason as string, raw: r.content };
  } catch (e) {
    return { score: 0, breakdown: null, raw: r.content, error: (e as Error).message };
  }
}

type ScoreOneOut = {
  itemId: string; kind: string; components: Record<string, unknown>; score: number; weighted: number;
  extracted?: unknown; thinkBonus?: number;
  timeOk?: number; distOk?: number;
};

async function scoreOne(callChat: CallChat, output: string, item: BenchItem, opts: Record<string, unknown> = {}): Promise<ScoreOneOut> {
  const text = String(output || '');
  const out: ScoreOneOut = { itemId: item.id, kind: item.kind, components: {}, score: 0, weighted: 0 };

  let thinkBonus = 0;
  if (/<thinking>[\s\S]*?<\/thinking>/i.test(text)) thinkBonus += 0.04;
  if (/\b(actually|wait|hmm|let me reconsider|i was wrong)\b/i.test(text)) thinkBonus += 0.02;
  if (/\b(counter-?example|edge case|worst case|concretely|numerically)\b/i.test(text)) thinkBonus += 0.02;
  out.components.thinkBonus = thinkBonus;

  switch (item.kind) {
    case 'math':
    case 'science':
    case 'math-aime': {
      const refObj = item.reference && typeof item.reference === 'object' && !Array.isArray(item.reference) ? item.reference as Record<string, unknown> : null;
      if (refObj && (refObj.time || refObj.distanceFromX != null)) {
        let timeOk = 0, distOk = 0;
        if (refObj.time) {
          const tm = extractTime(text);
          if (tm) {
            const [rh, rm] = String(refObj.time).split(':').map(Number);
            const tol = item.numericTolerance || 0.05;
            const dMin = Math.abs((tm.hour * 60 + tm.minute) - (rh * 60 + rm));
            timeOk = dMin <= Math.round(tol * 60) ? 1 : 0;
          }
        }
        if (refObj.distanceFromX != null) {
          const num = extractNumber(text);
          distOk = numericScore(num, refObj.distanceFromX as number, item.numericTolerance || 0.05);
        }
        const combo = (timeOk + distOk) / 2;
        out.components.numeric = combo;
        out.components.timeOk = timeOk;
        out.components.distOk = distOk;
        out.score = combo;
        out.extracted = { timeOk, distOk };
        break;
      }
      if (refObj && !('time' in refObj) && !('distanceFromX' in refObj)) {
        const m = multiNumberScore(text, refObj as Record<string, number>, item.numericTolerance || 0.05);
        out.components.numeric = m.score;
        out.score = m.score;
        out.extracted = { matched: m.matched, total: m.total, numbers: extractAllNumbers(text) };
        break;
      }
      // whole-answer fraction ("3/8" or "ANSWER: 3/8") → decimal, so it
      // matches a numeric ref. strip the ANSWER: prefix before matching.
      const t = norm(text);
      const ans = t.match(/ANSWER:\s*(.+)$/i)?.[1] || t;
      const frac = ans.match(/^(\d+)\s*\/\s*(\d+)$/);
      const num = frac ? parseInt(frac[1], 10) / parseInt(frac[2], 10) : extractNumber(text);
      let numeric = numericScore(num, item.reference as number, item.numericTolerance || 0.01);
      // exact symbolic forms ((1 - e^{-2})/2) never appear as decimals — fall
      // back to evaluating expressions in the output.
      if (numeric === 0 && evalSymbolic(text, item.reference as number, item.numericTolerance || 0.01)) numeric = 1;
      out.components.numeric = numeric;
      out.score = numeric;
      out.extracted = { number: num };
      break;
    }
    case 'letter': {
      // single-letter answers ("ANSWER: C"): exact match on the letter.
      const t = norm(text);
      const m = t.match(/ANSWER:\s*([A-Za-z]+)/i);
      const got = m ? m[1].toUpperCase() : (t.match(/[A-Za-z]+/)?.[0] || '').toUpperCase();
      out.components.letter = got === String(item.reference).toUpperCase() ? 1 : 0;
      out.score = out.components.letter as number;
      out.extracted = { letter: got };
      break;
    }
    case 'probability': {
      const num = extractProbability(text, item.reference as number);
      out.components.numeric = numericScore(num, item.reference as number, item.numericTolerance || 0.02);
      out.score = out.components.numeric as number;
      out.extracted = { probability: num };
      break;
    }
    case 'logic': {
      const t = norm(text).toLowerCase();
      let ok = 0;
      const ref = item.reference as { answer: string; mustMention?: string };
      if (t.includes(ref.answer.toLowerCase())) ok += 0.5;
      if (ref.mustMention) {
        for (const w of String(ref.mustMention).split(/\s*,\s*/)) {
          if (t.includes(w.toLowerCase())) ok += 0.25;
        }
      }
      out.components.logic = Math.min(1, ok);
      out.score = out.components.logic as number;
      out.extracted = { hasAnswer: t.includes(ref.answer.toLowerCase()) };
      break;
    }
    case 'deduction': {
      // space-insensitive ("n^2 + n" matches ref "n^2+n"); array reference =
      // any acceptable phrasing ("x1 < x2" or its mirror "x2 > x1")
      const t = normalizeMath(norm(text)).toLowerCase().replace(/\s+/g, '');
      const refs = Array.isArray(item.reference) ? item.reference : [item.reference];
      const refsNorm = refs.map((r) => String(r).toLowerCase().replace(/\s+/g, ''));
      const hit = refsNorm.some((r) => t.includes(r));
      out.components.deduction = hit ? 1 : 0;
      out.score = out.components.deduction as number;
      out.extracted = { mentionsRef: hit };
      break;
    }
    case 'code': {
      const r = await runCodeTests(text, item);
      out.components.code = r && r.total ? r.passed / r.total : 0;
      out.score = out.components.code as number;
      out.extracted = r || {};
      break;
    }
    case 'choice': {
      // multiple-choice IQ items: reference is the 1-based choice index,
      // model answers "ANSWER: <n>". prefer the ANSWER: line, else last number.
      const t = norm(text);
      const m = t.match(/ANSWER:\s*(\d+)/i);
      const num = m ? parseInt(m[1], 10) : extractNumber(text);
      const ref = Number(item.reference);
      out.components.choice = isFinite(num) && num === ref ? 1 : 0;
      out.score = out.components.choice as number;
      out.extracted = { choice: num };
      break;
    }
    case 'paradox':
    case 'planning':
    case 'hypothesis':
    case 'ethics': {
      const j = await llmJudge(callChat, text, item, opts);
      out.components.judge = j?.score || 0;
      out.score = out.components.judge as number;
      out.extracted = { judgeBreakdown: j?.breakdown, reason: (j as { reason?: string })?.reason || (j as { raw?: string })?.raw?.slice(0, 200) };
      break;
    }
    default: {
      // unknown kind = silent zero (the math-aime trap). shout instead.
      if (process.stdout?.write) process.stdout.write(`  [score] WARN unknown kind "${item.kind}" for ${item.id} — scoring 0\n`);
      out.score = 0;
    }
  }
  // thinkBonus only on CORRECT answers — otherwise a wrong answer that
  // rambles about techniques ("poincare-incubate: I hit the wall...")
  // still banks +0.04-0.08, which is exactly how the iq run gamed it:
  // pattern-name prose earned fitness on answers that were never right.
  out.weighted = (out.score > 0 ? out.score + thinkBonus : 0) * (item.weight || 1);
  return out;
}

async function scoreAgainstBench(callChat: CallChat, outputs: Record<string, string>, bench: BenchItem[], opts: Record<string, unknown> = {}): Promise<{ aggregate: number; detail: ScoreOneOut[]; totalWeight: number; totalWeighted: number }> {
  const detail: ScoreOneOut[] = [];
  let totalWeighted = 0, totalWeight = 0;
  for (const item of bench) {
    const out = outputs[item.id];
    if (out == null) {
      detail.push({ itemId: item.id, kind: item.kind, components: {}, score: 0, weighted: 0 });
      totalWeight += (item.weight || 1);
      continue;
    }
    const r = await scoreOne(callChat, out, item, opts);
    const safeWeighted = isFinite(r.weighted) ? r.weighted : 0;
    const safeScore = isFinite(r.score) ? r.score : 0;
    r.weighted = safeWeighted;
    r.score = safeScore;
    detail.push(r);
    totalWeighted += safeWeighted;
    totalWeight += (item.weight || 1);
  }
  return {
    aggregate: totalWeight > 0 ? totalWeighted / totalWeight : 0,
    detail,
    totalWeight,
    totalWeighted
  };
}

export { scoreOne, scoreAgainstBench, extractNumber, extractProbability, extractAllNumbers, multiNumberScore, extractTime, runPythonIfPresent, runCodeTests, llmJudge, numericScore };
export type { BenchItem, ScoreOneOut };
