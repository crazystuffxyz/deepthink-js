// thinking/think.ts
// parallel-probe internal reasoning. N independent ANSWER-PRODUCING probes
// on an identical prefix (KV cache shared — one prompt-eval), then selection:
// majority vote when ≥2 probes agree (skip synthesis), synthesis fallback
// when they disagree. every probe ends with "ANSWER: " so the wave yields
// N candidate answers — the self-consistency signal (Wang et al. 2022).
//
// research basis: on equal token budgets, independent sampling scales better
// than dependent sampling; verifier-guided search + self-consistency decoding
// is the frontier recipe (o1/o3, GPT-5.6 Sol consensus ladder); the probe
// techniques are the high-IQ moves that measurably move hard reasoning —
// chunking/working-memory offloading (Miller/Cowan), invariants (Engel),
// instantiation/pattern-mining (Ramanujan), System-2 disconfirmation
// (Kahneman & Klein), backward verification (RCoT), constraint relaxation
// (Duncker), analogical transfer (Gick & Holyoak).
//
// bodies are deliberately COMPACT: gemma writes verbose LaTeX and burns the
// whole output budget on long instructions — a 1-2 line nudge per technique
// is what actually lets it finish with the ANSWER line (tested).

import type { Message } from './types.js';

type CallChat = (messages: Message[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string; thinking?: string }>;

// probes are fire-and-forget internal reasoning: hard output cap keeps
// gemma from writing an essay per probe (it ignores "be concise").
// num_predict (ollama-native) — max_tokens is ignored by the ollama client.
// 1000: gemma's reasoning length is stochastic (300-700 tokens on AIME) —
// a 500 cap truncated the verbose samples before the ANSWER line, killing
// the consensus vote. the wave is parallel, so the cap only bounds the
// slowest probe, not the sum.
const PROBE_OPTS = { think: true, autoSystemPrompt: false, options: { num_predict: 1000 } };

const THINK_SYS = 'You are performing INTERNAL REASONING ONLY. Be short and concise.';

// the answer contract: "at most 10 lines" + "mandatory" is the phrasing
// that actually makes gemma finish with the ANSWER line (tested).
const ANSWER_LINE = 'Keep the reasoning tight (at most 10 lines). Then end with the final answer on a line starting with "ANSWER: " — the ANSWER line is mandatory and must be the last line.';

const SCRATCHPAD_BODY =
  'Use a structured scratchpad: KNOWN FACTS, GOAL, CONSTRAINTS, STEPS. Keep at most 5 live quantities; ' +
  'compress fully-verified sub-results into named chunks and refer to them by name. Verify the result against every constraint.';

const COMPUTE_BODY =
  'If computational (probability, counting, arithmetic, any numeric quantity): COMPUTE explicitly — ' +
  'enumerate the sample space, set up equations, evaluate with real numbers. No symmetry/intuition ' +
  'shortcuts. If not computational, state the exact formula/procedure and apply it.';

const STRATEGY_BODY =
  'Name 3 candidate strategies (invariants, extremal principle, working backwards, special cases, symmetry, ' +
  'pigeonhole, parity, reformulation, induction, contradiction, case analysis, generating functions, ' +
  'inclusion-exclusion). Pick the best for THIS problem and EXECUTE it fully. If computational, name the ' +
  'algorithm class (DP, greedy, search, number theory) and apply it.';

const BACKWARD_BODY =
  'Solve, then BACKWARD-VERIFY: reconstruct the problem from your solution and diff against the actual ' +
  'statement. Flag misread/missed/added constraints and ignored edge cases (zero, negatives, boundaries). ' +
  'Fix any error you find.';

const INVARIANT_BODY =
  'Search for an INVARIANT: a quantity preserved by every allowed operation (parity, sum, alternating sum, ' +
  'product, mod residue, count of a color class, orientation). Evaluate at initial vs goal state — differing ' +
  'values prove impossibility. Also try a MONOVARIANT (strictly monotone measure) to prove termination. Use it to solve.';

const INSTANTIATE_BODY =
  'Generate data first: instantiate the smallest concrete cases (n=1,2,3,4,5 or specific values), compute ' +
  'each fully, pattern-mine (sequence, periodicity, recurrence, closed form, symmetry). State a labeled ' +
  'conjecture, verify against ALL cases plus one new case, then prove it.';

const SYSTEM2_BODY =
  'Two passes. PASS 1: immediate answer labeled HYPOTHESIS with confidence %. PASS 2: assume it is wrong — ' +
  'build the strongest refutation (edge case, reasoning error). Re-derive load-bearing steps slowly. ' +
  'Deliver the survivor with the refutation documented.';

const CODE_BODY =
  'Write a Python script that computes the answer (sympy/fractions for exact arithmetic), one step per line, ' +
  'printing the final answer as its last line. Do NOT compute it yourself. Then reason about what it would ' +
  'output and give the final answer.';

const CONSTRAINT_BODY =
  'Question your constraints: list every one, mark GIVEN vs ASSUMED. RELAX one ASSUMED constraint and solve ' +
  'the relaxed problem (often dramatically easier, reveals the mechanism). Re-impose: does the solution ' +
  'adapt? Also try ADDING structure. Use the insight to solve.';

const ANALOGY_BODY =
  'Find an analog from a DIFFERENT domain (physics, games, programming, everyday life) with the same ' +
  'STRUCTURE. Build an explicit mapping table; discard if any relation breaks. Translate the solution back, ' +
  'verify against constraints, extract the ABSTRACT SCHEMA, use it to solve.';

// base roster by depth: easy 3, medium 5, hard 7. all answer-producing.
const BASE: Record<number, Array<{ tag: string; body: string }>> = {
  1: [
    { tag: 'scratchpad', body: SCRATCHPAD_BODY },
    { tag: 'compute', body: COMPUTE_BODY },
    { tag: 'strategy', body: STRATEGY_BODY }
  ],
  2: [
    { tag: 'scratchpad', body: SCRATCHPAD_BODY },
    { tag: 'compute', body: COMPUTE_BODY },
    { tag: 'strategy', body: STRATEGY_BODY },
    { tag: 'backward', body: BACKWARD_BODY },
    { tag: 'invariant', body: INVARIANT_BODY }
  ],
  3: [
    { tag: 'scratchpad', body: SCRATCHPAD_BODY },
    { tag: 'compute', body: COMPUTE_BODY },
    { tag: 'strategy', body: STRATEGY_BODY },
    { tag: 'backward', body: BACKWARD_BODY },
    { tag: 'invariant', body: INVARIANT_BODY },
    { tag: 'instantiate', body: INSTANTIATE_BODY },
    { tag: 'system2', body: SYSTEM2_BODY }
  ]
};

// conditional probes — the caller adds them via flags (code when the input
// is computational, constraint/analogy when it is hard).
const EXTRA: Record<string, { tag: string; body: string }> = {
  code: { tag: 'code', body: CODE_BODY },
  constraint: { tag: 'constraint', body: CONSTRAINT_BODY },
  analogy: { tag: 'analogy', body: ANALOGY_BODY }
};

const SYNTH_SYS =
  'You are the internal reasoning coordinator. Below are independent solution attempts of the same ' +
  'problem, each produced by a separate reasoning pass. Consolidate them into ONE coherent reasoning ' +
  'document.\n\n' +
  'SCORING: for each pass, judge whether its reasoning is sound (correct math, no misread constraints, ' +
  'no logical leaps). Base the final document on the SOUND passes. Explicitly flag or discard unsound ones ' +
  'and say why. If passes disagree on a number, recompute the disputed step yourself and keep the correct ' +
  'value. State which pass you are trusting and why.\n\n' +
  'Be concise — no preamble, no repetition of what the passes already agree on. ' +
  ANSWER_LINE;

/** pull the ANSWER: line out of a probe response */
function extractAnswer(text: string): string | null {
  if (!text) return null;
  const m = text.match(/ANSWER\s*:\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

/** loose equality for answer grouping: case, whitespace, trailing period */
function normAnswer(s: string): string {
  return String(s).trim().toLowerCase().replace(/[.\s]+$/g, '').replace(/\s+/g, ' ');
}

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
      // PROBE_OPTS sets the DEFAULT cap (500); a caller (the synthesis
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
): Promise<{
  analysis?: string;
  answers?: Array<{ tag: string; answer: string | null }>;
  consensus?: string | null;
  agreement?: number;
}> {
  const results: {
    analysis?: string;
    answers?: Array<{ tag: string; answer: string | null }>;
    consensus?: string | null;
    agreement?: number;
  } = {};
  if (depth <= 0) return results;

  const level = Math.min(Math.max(depth, 1), 3);
  // evolved guidance rides into the probes: the trained techniques are
  // reasoning moves, exactly what a probe should try. it's system-content,
  // so the KV-cache sharing across probes is preserved.
  const guide = (opts.evolvedGuide as string) || '';
  const probeSys = (p: { body: string }) =>
    `${THINK_SYS}\n${p.body}\n\n${ANSWER_LINE}` + (guide ? `\n\nAlso apply these techniques to your reasoning:\n${guide}` : '');

  // conditional probes: code when computational, constraint when hard,
  // analogy when hard AND not computational (novel-reasoning problems).
  const roster = [...BASE[level]];
  if (opts.codeProbe) roster.push(EXTRA.code);
  if (opts.hard) roster.push(EXTRA.constraint);
  if (opts.hard && !opts.codeProbe) roster.push(EXTRA.analogy);

  // wave 1: all probes in parallel — identical prefix, KV cache shared.
  // temp 0.7 for path diversity; independent draws, not a chain.
  const probeOpts = {
    ...opts,
    options: { ...(opts.options || {}), temperature: 0.7 }
  };
  const runWave = async (defs: Array<{ tag: string; body: string }>) => {
    const settled = await Promise.allSettled(defs.map((p) => probe(callChat, probeSys(p), inputText, probeOpts)));
    const out: Array<{ tag: string; text: string }> = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) out.push({ tag: defs[i].tag, text: r.value });
    });
    return out;
  };

  let wave = await runWave(roster);
  // depth-1 escalation: the easy probes disagree → add the depth-2 extras
  // (backward, invariant) and re-select. cheap second wave, same cache.
  if (level === 1) {
    const extras = BASE[2].filter((p) => !roster.some((q) => q.tag === p.tag));
    if (extras.length) {
      const more = await runWave(extras);
      wave = [...wave, ...more];
    }
  }

  const answers = wave.map((w) => ({ tag: w.tag, answer: extractAnswer(w.text) }));
  const groups = new Map<string, number>();
  for (const a of answers) {
    if (!a.answer) continue;
    const k = normAnswer(a.answer);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  let consensus: string | null = null;
  let agreement = 0;
  if (groups.size) {
    let best = '';
    let bestN = 0;
    for (const [k, n] of groups) if (n > bestN) { bestN = n; best = k; }
    if (bestN >= 2) { consensus = best; agreement = bestN / answers.length; }
  }

  const chunks = wave.map((w) => `${w.tag.toUpperCase()}:\n${w.text}`);
  if (!chunks.length) return results; // every probe died — degrade to no think ctx

  // wave 2: synthesis ONLY when probes disagree (hard case). lower temp for
  // fidelity; bigger cap since it carries the whole doc.
  if (!consensus) {
    const synth = await probe(
      callChat,
      SYNTH_SYS,
      `Problem:\n${inputText}\n\nIndependent passes:\n\n${chunks.join('\n\n')}\n\nCONSOLIDATED:`,
      { ...opts, options: { ...(opts.options || {}), temperature: 0.3, num_predict: 600 } }
    );
    if (synth) {
      chunks.push(`CONSOLIDATED:\n${synth}`);
      const sAns = extractAnswer(synth);
      if (sAns) {
        answers.push({ tag: 'synthesis', answer: sAns });
        // the synthesis answer votes too — if it lands on a probe's value,
        // that pair is now a consensus.
        const k = normAnswer(sAns);
        groups.set(k, (groups.get(k) || 0) + 1);
        let best = '';
        let bestN = 0;
        for (const [kk, n] of groups) if (n > bestN) { bestN = n; best = kk; }
        if (bestN >= 2) { consensus = best; agreement = bestN / answers.length; }
      }
    }
  }

  results.analysis = chunks.join('\n\n');
  results.answers = answers;
  results.consensus = consensus;
  results.agreement = agreement;
  return results;
}
