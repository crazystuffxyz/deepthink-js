// thinking/mixtureOfAgents.js — fan out to N providers, then merge with a judge
'use strict';

import { messagesToText, stripThinkBlocks } from './dataTypes.js';

function makeClient(opts) {
  // user passes { models: [{ name, callChat }] } — each entry has its own bound callChat
  return opts.models || [];
}

async function fanOut(callers, input, opts = {}) {
  const msgs = Array.isArray(input) ? input : [{ role: 'user', content: messagesToText(input) }];
  const tasks = callers.map(c => c.callChat(
    msgs,
    false,
    null,
    { ...opts, autoSystemPrompt: opts.autoSystemPrompt ?? false, think: opts.think !== false, samplingProfile: opts.samplingProfile || 'reasoning' }
  ).then(r => ({ name: c.name, content: stripThinkBlocks(r.content || '').trim() })).catch(e => ({ name: c.name, error: e.message })));
  return Promise.all(tasks);
}

async function judge(callChat, input, candidates, opts = {}) {
  const list = candidates.map((c, i) => `--- Candidate ${i + 1} [${c.name}] ---\n${c.content}`).join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are the merge judge. You receive multiple candidate answers to the same question. ' +
          'Produce a single, better answer that combines the strongest elements of each. ' +
          'Resolve contradictions by preferring the more specific / better-grounded claim. ' +
          'Output ONLY the merged final answer — no JSON, no preamble.'
      },
      { role: 'user', content: `Question:\n${messagesToText(input)}\n\nCandidates:\n${list}\n\nMerged answer:` }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

async function runMoA(callers, judgeCaller, input, opts = {}) {
  const out = await fanOut(callers, input, opts);
  const ok = out.filter(x => !x.error);
  if (!ok.length) throw new Error('mixtureOfAgents: all candidates failed');
  if (ok.length === 1) return { answer: ok[0].content, candidates: out };
  const merged = await judge(judgeCaller, input, ok, opts);
  return { answer: merged, candidates: out };
}

export { runMoA, fanOut, judge };
