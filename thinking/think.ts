// thinking/think.ts
// parallel-probe internal reasoning. instead of a sequential chain where
// every call sees the previous call's output (which invalidates the KV
// cache each step and serializes wall time), we fire N independent probes
// at the same problem with an IDENTICAL system+user prefix — Ollama caches
// that prefix once, so all probes share one prompt-eval — then ONE
// synthesis call recombines them into the final thinking doc.
//
// research basis: on equal token budgets, independent sampling (parallel
// probes) scales better than dependent sampling (sequential chain); and
// cache-friendly prompts cut input cost ~5x and wall time dramatically.

import type { Message } from './types.js';

type CallChat = (messages: Message[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string; thinking?: string }>;

// probes are fire-and-forget internal reasoning: hard output cap keeps
// gemma from writing an essay per probe (it ignores "be concise").
// num_predict (ollama-native) — max_tokens is ignored by the ollama client.
const PROBE_OPTS = { think: true, autoSystemPrompt: false, options: { num_predict: 300 } };

const THINK_SYS =
  'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. ' +
  'Do NOT produce any code or final deliverable. Be short and concise.';

// each probe: distinct lens on the same problem. same prefix, independent
// sampling (temp 0.7 gives path diversity; the synthesis repairs gaps).
const PROBES: Record<number, Array<{ tag: string; body: string; fmt: string }>> = {
  1: [
    {
      tag: 'analysis',
      body: 'Perform rigorous mathematical and logical decomposition. Decompose the request into primitive logical units. ' +
        'Isolate all explicit and implicit variables, state boundary conditions, and define constraints using extreme-case analysis. ' +
        'Proactively identify potential off-by-one errors and domain-boundary violations.',
      fmt: 'ANALYSIS:\n[3-6 bullet points max, no prose preamble]'
    },
    {
      tag: 'intent',
      body: 'Identify the core intent, emotional subtext, ambiguities, and technical requirements.',
      fmt: 'I need to:\n1. [step]\n2. [step]\n3. [step]'
    }
  ],
  2: [
    {
      tag: 'analysis',
      body: 'Perform rigorous mathematical and logical decomposition. Decompose the request into primitive logical units. ' +
        'Isolate all explicit and implicit variables, state boundary conditions, and define constraints using extreme-case analysis. ' +
        'Proactively identify potential off-by-one errors and domain-boundary violations.',
      fmt: 'ANALYSIS:\n[3-6 bullet points max, no prose preamble]'
    },
    {
      tag: 'plan',
      body: 'Generate an optimal computational strategy. Formulate a proof-sketch or step-by-step algorithm. ' +
        'Ensure that your plan defines a strict loop-invariant and verify that each step is constructively justified. ' +
        'Avoid non-constructive assertions.',
      fmt: '**Plan:**\n[concise plan — max 5 steps]'
    },
    {
      tag: 'working',
      body: 'Work through the problem systematically using numbered steps and sub-bullets. Show the actual computation.',
      fmt: 'WORKING:\n1. [step]\n   - [sub-detail]\n2. [step]'
    },
    {
      tag: 'structure',
      body: 'Define the structure of the final response in exactly 5 numbered steps.',
      fmt: '**Response Structure:**\n1. [step]\n2. [step]\n3. [step]\n4. [step]\n5. [step]'
    }
  ],
  3: [
    {
      tag: 'analysis',
      body: 'Perform rigorous mathematical and logical decomposition. Decompose the request into primitive logical units. ' +
        'Isolate all explicit and implicit variables, state boundary conditions, and define constraints using extreme-case analysis. ' +
        'Proactively identify potential off-by-one errors and domain-boundary violations.',
      fmt: 'ANALYSIS:\n[3-6 bullet points max, no prose preamble]'
    },
    {
      tag: 'plan',
      body: 'Generate an optimal computational strategy. Formulate a proof-sketch or step-by-step algorithm. ' +
        'Ensure that your plan defines a strict loop-invariant and verify that each step is constructively justified. ' +
        'Avoid non-constructive assertions.',
      fmt: '**Plan:**\n[concise plan — max 5 steps]'
    },
    {
      tag: 'working',
      body: 'Work through the problem systematically using numbered steps and sub-bullets. Show the actual computation.',
      fmt: 'WORKING:\n1. [step]\n   - [sub-detail]\n2. [step]'
    },
    {
      tag: 'sanity',
      body: 'Perform a rigorous, adversarial audit. Actively attempt to falsify the working: search for sign errors, ' +
        'division-by-zero vulnerabilities, boundary-condition leaks, and logical non-sequiturs. ' +
        'Do not restate assumptions — attack the calculations.',
      fmt: 'SANITY CHECK:\n[findings — max 6 bullet points]'
    },
    {
      tag: 'alternative',
      body: 'Propose an alternative method — a different algorithmic approach, different framing, or different structure.',
      fmt: 'ALTERNATIVE:\n[max 100 words]'
    }
  ]
};

const SYNTH_SYS =
  'You are the internal reasoning coordinator. Below are independent analyses of the same problem, ' +
  'each produced by a separate reasoning pass. Consolidate them into ONE coherent reasoning document: ' +
  'keep the strongest working, merge distinct insights, and explicitly resolve any conflicts between passes. ' +
  'Be concise — no preamble, no repetition of what the passes already agree on.';

async function probe(
  callChat: CallChat,
  systemContent: string,
  userContent: string,
  opts: Record<string, unknown>
): Promise<string> {
  const r = await callChat(
    [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ],
    false,
    null,
    {
      ...opts,
      ...PROBE_OPTS,
      // PROBE_OPTS sets the DEFAULT cap (300); a caller (the synthesis
      // pass) may override with its own num_predict. merge caller-last.
      options: { ...(PROBE_OPTS.options as Record<string, unknown>), ...(opts.options || {}) }
    }
  );
  // gemma's thinking mode routes the whole response into `thinking` and
  // leaves `content` empty when the task says "internal reasoning only" —
  // the probe's deliverable IS that internal stream, so fall back to it.
  return ((r.content || '').trim() || (r.thinking || '').trim());
}

export async function runThink(
  callChat: CallChat,
  inputText: string,
  depth: number,
  opts: Record<string, unknown>
): Promise<{ analysis?: string }> {
  const results: { analysis?: string } = {};
  if (depth <= 0) return results;

  const level = Math.min(Math.max(depth, 1), 3);
  const probesDef = PROBES[level];

  // wave 1: all probes in parallel — identical prefix, KV cache shared.
  // temp 0.7 for path diversity; independent draws, not a chain.
  const probeOpts = {
    ...opts,
    options: { ...(opts.options || {}), temperature: 0.7 }
  };
  const settled = await Promise.allSettled(
    probesDef.map((p) => probe(callChat, `${THINK_SYS}\n${p.body}\nOutput format:\n${p.fmt}`, inputText, probeOpts))
  );

  const chunks: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      chunks.push(`${probesDef[i].tag.toUpperCase()}:\n${r.value}`);
    }
  });
  if (!chunks.length) return results; // every probe died — degrade to no think ctx

  // wave 2: one synthesis pass recombines the probes (the only sequential
  // step). lower temp for fidelity; bigger cap since it carries the whole doc.
  const synth = await probe(
    callChat,
    SYNTH_SYS,
    `Problem:\n${inputText}\n\nIndependent passes:\n\n${chunks.join('\n\n')}\n\nCONSOLIDATED:`,
    { ...opts, options: { ...(opts.options || {}), temperature: 0.3, num_predict: 600 } }
  );
  if (synth) chunks.push(`CONSOLIDATED:\n${synth}`);

  results.analysis = chunks.join('\n\n');
  return results;
}
