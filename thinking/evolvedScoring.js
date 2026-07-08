// thinking/evolvedScoring.js — score a single candidate output against a benchmark item
'use strict';

import { numericScore, includesAnyCaseInsensitive } from './benchmarkSet.js';
import { stripCodeFences, stripThinkBlocks, parseDataType, extractJSON } from './dataTypes.js';
import { runJSSandbox, runPythonSandbox } from './codeGenerator.js';

// normalize the response: kill think blocks, kill fences, trim.
function norm(text) {
  return stripCodeFences(stripThinkBlocks(String(text || ''))).trim();
}

// for a math/probability item, try to find the number in the text
export function extractNumber(text) {
  const t = norm(text);
  // try direct parse first
  const direct = parseDataType(t, 'double');
  if (typeof direct === 'number' && !isNaN(direct) && isFinite(direct)) return direct;
  // last-number fallback
  const m = t.match(/-?\d+(?:\.\d+)?/g);
  if (!m) return NaN;
  return parseFloat(m[m.length - 1]);
}

// for probability: a model often answers "27.8%" or "0.278". try both scales.
export function extractProbability(text, ref) {
  const t = norm(text).toLowerCase();
  // strip percent sign, try direct
  const cleaned = t.replace(/%/g, '');
  const direct = parseDataType(cleaned, 'double');
  if (typeof direct === 'number' && isFinite(direct)) {
    // if ref is < 1 and the direct is >= 1 and there's a % sign, scale
    if (ref > 0 && ref < 1 && direct >= 1 && t.includes('%')) {
      return direct / 100;
    }
    return direct;
  }
  return extractNumber(text);
}

// pull all numbers from text, in order. used for multi-answer problems.
export function extractAllNumbers(text) {
  const t = norm(text);
  const m = t.match(/-?\d+(?:\.\d+)?/g);
  if (!m) return [];
  return m.map(s => parseFloat(s)).filter(x => isFinite(x));
}

// score a multi-answer problem: each expected answer must appear in the text
// within tolerance. reference is { label: value, ... } or [value, value, ...].
export function multiNumberScore(text, reference, tol) {
  const nums = extractAllNumbers(text);
  let entries = [];
  if (Array.isArray(reference)) entries = reference.map((v, i) => [`a${i}`, v]);
  else entries = Object.entries(reference);
  if (entries.length === 0 || nums.length === 0) return { score: 0, matched: 0, total: entries.length };
  // greedy match: for each expected, find the closest extracted number, mark used
  const used = new Set();
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

// for a "what time" item, parse HH:MM or minutes
function extractTime(text) {
  const t = norm(text);
  const m = t.match(/(\d{1,2})[:.](\d{2})/);
  if (m) return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
  return null;
}

// attempt to run Python code in a candidate response
async function runPythonIfPresent(text) {
  const m = text.match(/```python\s*([\s\S]*?)```/i) || text.match(/<code[^>]*>\s*([\s\S]*?)\s*<\/code>/i);
  if (!m) return null;
  try {
    return await runPythonSandbox(m[1].trim());
  } catch (e) {
    return { error: e.message };
  }
}

// run the python function on the test cases for a code benchmark
async function runCodeTests(text, item) {
  if (!item.reference || !item.reference.testCases) return null;
  const py = await runPythonIfPresent(text);
  if (!py) return { ran: false, passed: 0, total: item.reference.testCases.length, error: 'no code block' };
  if (py.error) return { ran: false, passed: 0, total: item.reference.testCases.length, error: py.error };

  // the function should be defined; we cannot directly import the function from the sandbox,
  // so we wrap and re-exec with the test cases appended.
  const fn = text.match(/```python\s*([\s\S]*?)```/i)?.[1]?.trim() || '';
  if (!fn) return { ran: false, passed: 0, total: item.reference.testCases.length, error: 'no function body' };

  // figure out the function name to call. prefer the reference's functionName, else
  // grab the first `def NAME(` from the candidate code, else fall back to a generic name.
  let fnName = item.reference.functionName;
  if (!fnName) {
    const m = fn.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
    if (m) fnName = m[1];
  }
  if (!fnName) fnName = 'solution';

  const arity = (fn.match(/def\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(([^)]*)\)/)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean).length;
  const inputs = item.reference.testCases.map(tc => {
    // 1-arg call: pass first arg. 2-arg: pass both. otherwise pass the whole thing
    if (arity <= 1) {
      const parts = String(tc.input).split(',');
      return parts[0];
    }
    return `(${tc.input})`;
  });

  const harness = item.reference.testCases.map((tc, i) => {
    const call = arity <= 1 ? `${fnName}(${inputs[i]})` : `${fnName}(${inputs[i].slice(1, -1)})`;
    return `try:\n    got = ${call}\n    ok = (got == ${tc.expected})\n    print(f"tc{i}:{int(ok)}:{got}")\nexcept Exception as e:\n    print(f"tc{i}:0:ERR:{e}")`;
  }).join('\n');

  try {
    const out = await runPythonSandbox(fn + '\n\n' + harness);
    const outText = String(out || '');
    let passed = 0;
    const total = item.reference.testCases.length;
    for (let i = 0; i < total; i++) {
      if (outText.includes(`tc${i}:1`)) passed++;
    }
    return { ran: true, passed, total, fnName };
  } catch (e) {
    return { ran: false, passed: 0, total: item.reference.testCases.length, error: e.message };
  }
}

// LLM judge for rubric-based items. prompt the LLM to score 0-1 on each rubric dim.
async function llmJudge(callChat, text, item, opts) {
  if (!item.rubric) return null;
  const rubricKeys = Object.keys(item.rubric);
  const rubricText = rubricKeys.map(k => `- ${k}: weight ${item.rubric[k]}`).join('\n');
  const prompt = `You are a strict grader. Score the following response on these dimensions, each 0-1.

${rubricText}

Output ONLY valid JSON of this exact form:
{"${rubricKeys.map(k => `"${k}": 0.0`).join(', ')}", "reason": "one short sentence"}

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
    const j = extractJSON(r.content || '{}');
    let score = 0;
    for (const k of rubricKeys) {
      const v = Math.max(0, Math.min(1, Number(j[k]) || 0));
      score += v * item.rubric[k];
    }
    return { score: Math.max(0, Math.min(1, score)), breakdown: j, raw: r.content };
  } catch (e) {
    return { score: 0, breakdown: null, raw: r.content, error: e.message };
  }
}

// score one (candidate, item) pair. returns 0-1 with breakdown metadata.
export async function scoreOne(callChat, output, item, opts = {}) {
  const text = String(output || '');
  const out = { itemId: item.id, kind: item.kind, components: {}, score: 0 };

  // small bonus if the response includes a visible think block or self-correction
  // markers. nudges evolution toward prompts that elicit explicit reasoning.
  let thinkBonus = 0;
  if (/<thinking>[\s\S]*?<\/thinking>/i.test(text)) thinkBonus += 0.04;
  if (/\b(actually|wait|hmm|let me reconsider|i was wrong)\b/i.test(text)) thinkBonus += 0.02;
  if (/\b(counter-?example|edge case|worst case|concretely|numerically)\b/i.test(text)) thinkBonus += 0.02;
  out.components.thinkBonus = thinkBonus;

  switch (item.kind) {
    case 'math':
    case 'science': {
      // if reference is a { time, distanceFromX } object, parse both
      if (item.reference && typeof item.reference === 'object' && (item.reference.time || item.reference.distanceFromX != null)) {
        let timeOk = 0, distOk = 0;
        if (item.reference.time) {
          const tm = extractTime(text);
          if (tm) {
            const [rh, rm] = String(item.reference.time).split(':').map(Number);
            const tol = item.numericTolerance || 0.05;
            const dMin = Math.abs((tm.hour * 60 + tm.minute) - (rh * 60 + rm));
            // ±tol as fraction of an hour, so 0.05 ≈ 3 min
            timeOk = dMin <= Math.round(tol * 60) ? 1 : 0;
          }
        }
        if (item.reference.distanceFromX != null) {
          const num = extractNumber(text);
          distOk = numericScore(num, item.reference.distanceFromX, item.numericTolerance || 0.05);
        }
        const combo = (timeOk + distOk) / 2;
        out.components.numeric = combo;
        out.components.timeOk = timeOk;
        out.components.distOk = distOk;
        out.score = combo;
        out.extracted = { timeOk, distOk };
        break;
      }
      // multi-number reference (object with several numeric fields, or array)
      if (item.reference && typeof item.reference === 'object' && !('time' in item.reference) && !('distanceFromX' in item.reference)) {
        const m = multiNumberScore(text, item.reference, item.numericTolerance || 0.05);
        out.components.numeric = m.score;
        out.score = m.score;
        out.extracted = { matched: m.matched, total: m.total, numbers: extractAllNumbers(text) };
        break;
      }
      // plain number reference
      const num = extractNumber(text);
      out.components.numeric = numericScore(num, item.reference, item.numericTolerance || 0.01);
      out.score = out.components.numeric;
      out.extracted = { number: num };
      break;
    }
    case 'probability': {
      const num = extractProbability(text, item.reference);
      out.components.numeric = numericScore(num, item.reference, item.numericTolerance || 0.02);
      out.score = out.components.numeric;
      out.extracted = { probability: num };
      break;
    }
    case 'logic': {
      const t = norm(text).toLowerCase();
      let ok = 0;
      if (t.includes(item.reference.answer.toLowerCase())) ok += 0.5;
      if (item.reference.mustMention) {
        for (const w of String(item.reference.mustMention).split(/\s*,\s*/)) {
          if (t.includes(w.toLowerCase())) ok += 0.25;
        }
      }
      // cap at 1
      out.components.logic = Math.min(1, ok);
      out.score = out.components.logic;
      out.extracted = { hasAnswer: t.includes(item.reference.answer.toLowerCase()) };
      break;
    }
    case 'deduction': {
      const t = norm(text).toLowerCase();
      const ref = String(item.reference).toLowerCase();
      out.components.deduction = t.includes(ref) ? 1 : 0;
      out.score = out.components.deduction;
      out.extracted = { mentionsRef: t.includes(ref) };
      break;
    }
    case 'code': {
      const r = await runCodeTests(text, item);
      out.components.code = r && r.total ? r.passed / r.total : 0;
      out.score = out.components.code;
      out.extracted = r || {};
      break;
    }
    case 'paradox':
    case 'planning':
    case 'hypothesis':
    case 'ethics': {
      const j = await llmJudge(callChat, text, item, opts);
      out.components.judge = j?.score || 0;
      out.score = out.components.judge;
      out.extracted = { judgeBreakdown: j?.breakdown, reason: j?.reason || j?.raw?.slice(0, 200) };
      break;
    }
    default: {
      out.score = 0;
    }
  }
  // weight
  out.weighted = (out.score + thinkBonus) * (item.weight || 1);
  return out;
}

// score a candidate against the full benchmark. returns aggregate + per-item detail.
export async function scoreAgainstBench(callChat, outputs, bench, opts = {}) {
  const detail = [];
  let totalWeighted = 0, totalWeight = 0;
  for (const item of bench) {
    const out = outputs[item.id];
    if (out == null) {
      detail.push({ itemId: item.id, score: 0, weighted: 0, error: 'no output' });
      totalWeight += (item.weight || 1);
      continue;
    }
    const r = await scoreOne(callChat, out, item, opts);
    // defensive: any NaN/undefined → 0 so aggregate stays finite
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
