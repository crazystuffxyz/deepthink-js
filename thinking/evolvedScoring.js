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
function extractNumber(text) {
  const t = norm(text);
  // try direct parse first
  const direct = parseDataType(t, 'double');
  if (typeof direct === 'number' && !isNaN(direct) && isFinite(direct)) return direct;
  // last-number fallback
  const m = t.match(/-?\d+(?:\.\d+)?/g);
  if (!m) return NaN;
  return parseFloat(m[m.length - 1]);
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

  const harness = item.reference.testCases.map((tc, i) =>
    `try:\n    got = is_palindrome(${tc.input})\n    ok = (got == ${tc.expected})\n    print(f"tc{i}:{int(ok)}:{got}")\nexcept Exception as e:\n    print(f"tc{i}:0:ERR:{e}")`
  ).join('\n');

  try {
    const out = await runPythonSandbox(fn + '\n\n' + harness);
    const text = String(out || '');
    let passed = 0;
    let total = item.reference.testCases.length;
    for (let i = 0; i < total; i++) {
      if (text.includes(`tc${i}:1`)) passed++;
    }
    return { ran: true, passed, total };
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
      // plain number reference
      const num = extractNumber(text);
      out.components.numeric = numericScore(num, item.reference, item.numericTolerance || 0.01);
      out.score = out.components.numeric;
      out.extracted = { number: num };
      break;
    }
    case 'probability': {
      const num = extractNumber(text);
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
