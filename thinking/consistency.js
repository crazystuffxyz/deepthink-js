// thinking/consistency.js — sample N candidates, vote, return majority
'use strict';

import { stripThinkBlocks, messagesToText } from './dataTypes.js';

// keep the public surface tiny. everything is one async fn.
async function sampleOnce(callChat, input, opts) {
  const msgs = Array.isArray(input) ? input : [{ role: 'user', content: messagesToText(input) }];
  const r = await callChat(msgs, false, null, {
    ...opts,
    samplingProfile: opts.samplingProfile || 'reasoning',
    think: opts.think !== false,
    autoSystemPrompt: opts.autoSystemPrompt ?? false,
  });
  return (r.content || '').trim();
}

// Naive majority vote on stripped text. Falls back to longest for unique strings.
function vote(samples) {
  if (!samples.length) return '';
  const counts = new Map();
  for (const s of samples) {
    const k = s.replace(/\s+/g, ' ').trim();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = '', bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && k.length > best.length)) { best = k; bestN = n; }
  }
  return best;
}

// Sample N candidates in parallel, vote. Good for factual questions.
async function selfConsistency(callChat, input, opts = {}) {
  const n = Math.max(1, Math.min(opts.samples || 5, 11));
  const profile = opts.samplingProfile || 'reasoning';
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(sampleOnce(callChat, input, { ...opts, samplingProfile: profile }));
  }
  const out = await Promise.allSettled(tasks);
  const ok = out.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) throw new Error('selfConsistency: all samples failed');
  const winner = vote(ok);
  return { answer: winner, samples: ok, count: ok.length, votes: winner === vote(ok) ? 1 : 0 };
}

export { selfConsistency, vote, sampleOnce };
