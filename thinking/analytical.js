'use strict';

import { messagesToText, stripCodeFences, parseDataType } from './dataTypes.js';
async function analyzeDecomposability(callChat, inputText, analyticalDepth, opts) {
  const r = await callChat([{
    role: 'system',
    content: `You are a problem decomposition engine (depth ${analyticalDepth}).\n` + `Determine if this problem has 2-4 INDEPENDENT sub-problems — parts that do NOT depend on each other.\n` + `Be MORE conservative at depth >= 2. Atomic/single questions are never decomposable.\n\n` + `Output ONLY valid JSON:\n` + `{"decomposable":true,"subProblems":["..."],"mergeOperation":"add"|"multiply"|"custom","sharedConstraints":["..."]}\n` + `OR {"decomposable":false,"subProblems":[]}`
  }, {
    role: 'user',
    content: inputText
  }], false, null, {
    ...opts,
    think: false
  });
  try {
    return JSON.parse(stripCodeFences(r.content || '{}'));
  } catch {
    return {
      decomposable: false,
      subProblems: []
    };
  }
}
async function mergeSubResults(callChat, originalInput, subProblems, subResults, decomp, opts) {
  const op = decomp?.mergeOperation;
  if (op === 'add' || op === 'multiply') {
    const nums = subResults.map(r => parseDataType(String(r), 'double'));
    if (nums.every(n => !isNaN(n) && isFinite(n))) {
      const result = op === 'add' ? nums.reduce((a, b) => a + b, 0) : nums.reduce((a, b) => a * b, 1);
      console.log(`\x1b[36m[MERGE] Programmatic ${op}: ${nums.join(op === 'add' ? '+' : '×')} = ${result}\x1b[0m`);
      return String(result);
    }
    console.warn('\x1b[33m[MERGE] Non-numeric elements or parsing failure — falling back to LLM synthesis\x1b[0m');
  }
  const mergeText = subProblems.map((sp, i) => `Sub-problem ${i + 1}: ${sp}\nResult: ${subResults[i]}`).join('\n\n');
  const constraintNote = decomp?.sharedConstraints?.length ? `\n\nShared Constraints:\n${decomp.sharedConstraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}` : '';
  const r = await callChat([{
    role: 'system',
    content: 'Synthesize multiple sub-problem results into ONE complete final answer. Output ONLY the synthesized answer.'
  }, {
    role: 'user',
    content: `Original: ${messagesToText(originalInput)}\n\n${mergeText}${constraintNote}\n\nSynthesized answer:`
  }], false, null, {
    ...opts,
    think: false
  });
  return (r.content || '').trim();
}
async function analyzeAndSolve(ctx, input, type, depth, checks, onChunk, opts, analyticalDepth = 0) {
  const {
    callChat,
    generate,
    limiter
  } = ctx;
  const max = opts.analyticalMaxDepth ?? 4;
  const inputText = messagesToText(input);
  if (analyticalDepth >= max) return generate(input, {
    ...opts,
    type,
    depth,
    checks,
    onChunk,
    analytical: false
  });
  const decomp = await analyzeDecomposability(callChat, inputText, analyticalDepth, opts);
  if (!decomp.decomposable || !Array.isArray(decomp.subProblems) || decomp.subProblems.length < 2) {
    console.log(`\x1b[36m[ANALYTICAL D${analyticalDepth}] Atomic — solving directly\x1b[0m`);
    return generate(input, {
      ...opts,
      type,
      depth,
      checks,
      onChunk: analyticalDepth === 0 ? onChunk : null,
      analytical: false
    });
  }
  console.log(`\x1b[36m[ANALYTICAL D${analyticalDepth}] Decomposing into ${decomp.subProblems.length} sub-problems (merge: ${decomp.mergeOperation})\x1b[0m`);
  const subResults = await Promise.all(decomp.subProblems.map(sp => limiter.run(() => analyzeAndSolve(ctx, sp, type, depth, 0, null, {
    ...opts,
    analytical: true
  }, analyticalDepth + 1))));
  const merged = await mergeSubResults(callChat, input, decomp.subProblems, subResults, decomp, opts);
  return parseDataType(merged, type !== 'string' ? type : 'string');
}
export { analyzeAndSolve };