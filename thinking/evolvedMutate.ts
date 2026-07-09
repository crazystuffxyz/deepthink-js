// thinking/evolvedMutate.ts
// ways to mutate a prompt-template candidate. Most are LLM-implemented,
// a few are pure string/structural ops done in JS.
import { fingerprint, fableMetaPrompt } from './thinkingPatterns.js';

type Candidate = { id: string; parent: string | null; operator: string; systemPrompt: string; n: number; names: string[]; thinkers: string[]; tone: string; [k: string]: unknown };
type Ctx = { callChat: (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>; opts: Record<string, unknown>; leaderboard?: { score: number; systemPrompt: string }[] };
type Op = { name: string; description: string; apply: (parent: Candidate, ctx: Ctx) => Promise<Candidate[]> };
type ChatMessage = { role: string; content: string };

import { stripCodeFences, stripThinkBlocks } from './dataTypes.js';

const OPERATORS: Op[] = [
  {
    name: 'addReconsider',
    description: 'Add a "wait, let me reconsider" instruction after every major step.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n7. mid-flight-reconsider (Kahneman) — After each numbered step above, write one sentence: "Wait — would I still bet on that answer?" If you would not, revise the previous step before continuing.\n   When in doubt, slow down. The first answer is a hypothesis, not a conclusion.'
      );
      return [child];
    }
  },
  {
    name: 'addFeynmanElaboration',
    description: 'Force a final-pass Feynman elaboration before delivering the answer.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n8. feynman-elaborate (Richard Feynman) — Before your final answer, restate the entire solution as if to a curious five-year-old. If you cannot, you have a hidden hand-wave. Find it, fix it, then answer.'
      );
      return [child];
    }
  },
  {
    name: 'addCounterExample',
    description: 'Insert a counter-example search after every claim.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n9. erdos-counterexample (Paul Erdős) — For every claim you make, try once to construct a counter-example. If you find one, mark the claim as false and revise. Only survive after 3 failed attempts.'
      );
      return [child];
    }
  },
  {
    name: 'addVerification',
    description: 'Verify the answer with a different method.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n10. knuth-worst-case (Donald Knuth) — Verify your final answer by a different method than the one that produced it. If the methods disagree, the second method wins. If you cannot produce a second method, mark the answer unverified.'
      );
      return [child];
    }
  },
  {
    name: 'addDevilsAdvocate',
    description: 'Argue against your own answer for 3 sentences.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n11. skeptic-stance (Carl Sagan / Kahneman) — Before committing, write 3 sentences attacking your own answer as a hostile reviewer would. If any of them is plausible, fix the answer. Only after the attack fails should you commit.'
      );
      return [child];
    }
  },
  {
    name: 'addNumericalSanity',
    description: 'Estimate the order of magnitude before answering.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n12. hard-sf-check (Fermi) — For any number in your answer, first state an order-of-magnitude estimate ("should be between X and Y"). If your computed value is outside that range, you have a unit error. Find it before continuing.'
      );
      return [child];
    }
  },
  {
    name: 'addAnalogy',
    description: 'Find an analogy that makes the core mechanism intuitive.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n13. lovelace-poetical-science (Ada Lovelace) — Before your final answer, find one analogy from an unrelated domain that captures the structure of your solution. State the analogy in one sentence, then deliver the answer.'
      );
      return [child];
    }
  },
  {
    name: 'addParallelDrafts',
    description: 'Generate 2 drafts in parallel, keep the one that survives more tests.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n14. neumann-parallel-drafts (John von Neumann) — Sketch TWO different solutions before refining either. Test each against the hardest input you can construct. Keep the one that fails less. Only then refine.'
      );
      return [child];
    }
  },
  {
    name: 'addLemmaDecompose',
    description: 'Decompose into small lemmas, prove each.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n15. ttao-lemma-decompose (Terence Tao) — Do not try to solve the whole problem at once. State the smallest lemma that, if true, would unblock the next step. Prove that lemma. Then state the next.'
      );
      return [child];
    }
  },
  {
    name: 'addIncubation',
    description: 'If stuck, walk away and re-frame.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n16. poincare-incubate (Henri Poincaré) — If you find yourself writing the same approach for the third time, STOP. State explicitly: if a solution exists, what shape would it have? Then attempt only that shape. Do not retry the failed approach.'
      );
      return [child];
    }
  },
  {
    name: 'changeToneSocratic',
    description: 'Rewrite the prompt in Socratic mode (questions before answers).',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys.replace(/^For each technique below, follow the instruction\. Do not skip any\./, 'For each technique below, FIRST ask yourself the question it implies, ANSWER it out loud, THEN act. No step without a question.')
      );
      return [child];
    }
  },
  {
    name: 'compressToHalf',
    description: 'Rewrite the prompt in roughly half the characters without losing any stage.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys.replace(/\s+/g, ' ').replace(/\.\s+/g, '. ').trim().slice(0, Math.floor(sys.length / 2) + 50)
      );
      return [child];
    }
  },
  {
    name: 'fableThinkFormat',
    description: 'Force a visible <thinking> block at the start, with explicit "actually…" self-correction markers.',
    async apply(parent, ctx) {
      const fable = fableMetaPrompt({ profile: 'default', intensity: 'medium' });
      const child = await rewrite(parent, () => fable);
      child.operator = 'fableThinkFormat';
      return [child];
    }
  },
  {
    name: 'fableClassify',
    description: 'Add an explicit classify-then-route step at the start: ASSERTION / STUCK / BUILD / ANOMALY.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n17. classify-then-route (Feynman + Poincaré + Tao) — In one sentence, classify this problem as ASSERTION, STUCK, BUILD, or ANOMALY. Then apply the matching moves: ASSERTION→baloney+counterexample, STUCK→incubate+form-first, BUILD→worst-case+parallel-drafts, ANOMALY→anomaly+form-first. Always end with a System-2 slow re-check.'
      );
      return [child];
    }
  },
  {
    name: 'fableInternalCritic',
    description: 'Force a hostile internal critic loop.',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n18. neumann-internal-critic (John von Neumann) — You have a candidate answer. Now imagine a hostile critic has 60 seconds to destroy it. What is the most embarrassing mistake they would find? Patch it. Then imagine a second critic. Patch again. Stop when the same critic returns with the same complaint twice.'
      );
      return [child];
    }
  },
  {
    name: 'fableCalibrate',
    description: 'Force explicit per-claim confidence tags (CLAIM / CONFIDENCE / GROUNDS).',
    async apply(parent, ctx) {
      const child = await rewrite(parent, (sys: string) =>
        sys + '\n\n19. explicit-uncertainty (calibration) — For each load-bearing claim in your answer, write: CLAIM: [statement]  CONFIDENCE: [0-100%]  GROUNDS: [why not lower, why not higher]. If any claim is below 70%, either raise it with new grounds or flag it as a known weak link in the final answer.'
      );
      return [child];
    }
  },
  {
    name: 'fableHighIntensity',
    description: 'Convert to a high-intensity 5-stage workflow: classify, decompose, attack, reconsider, verify.',
    async apply(parent, ctx) {
      const fable = fableMetaPrompt({ profile: 'default', intensity: 'high' });
      const child = await rewrite(parent, () => fable);
      child.operator = 'fableHighIntensity';
      return [child];
    }
  }
];

async function rewrite(parent: Candidate, mutateFn: (sys: string) => string): Promise<Candidate> {
  const newPrompt = mutateFn(parent.systemPrompt);
  return {
    id: parent.id,
    parent: parent.id,
    operator: '(structural)',
    systemPrompt: newPrompt,
    ...fingerprint(newPrompt)
  };
}

async function llmRewrite(parent: Candidate, ctx: Ctx, op: Op): Promise<Candidate | null> {
  const leaderboard = ctx.leaderboard
    ? '\n\nTop prompts so far:\n' + ctx.leaderboard.map((c, i) => `${i + 1}. (score ${c.score.toFixed(2)}) ${c.systemPrompt.slice(0, 400)}`).join('\n\n')
    : '';
  const sys = 'You are a prompt engineer. You produce a NEW system prompt for a reasoning LLM, given a parent prompt and an operator description.\n' +
              'Output ONLY the new system prompt. No preamble, no quotes, no commentary.';
  const user = `Parent system prompt:
"""
${parent.systemPrompt}
"""

Operator: ${op.name} — ${op.description}
${leaderboard}

Constraints:
- keep under 1200 characters
- preserve at least 2 of the parent's techniques
- introduce ONE new idea not present in the parent

New system prompt:`;
  const r = await ctx.callChat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    false, null,
    { ...ctx.opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning', temperature: 0.7 }
  );
  let newPrompt = stripCodeFences(stripThinkBlocks(r.content || '')).trim();
  if (newPrompt.length > 1500) newPrompt = newPrompt.slice(0, 1500);
  if (newPrompt.length < 80) return null;
  return {
    id: parent.id,
    parent: parent.id,
    operator: op.name,
    systemPrompt: newPrompt,
    ...fingerprint(newPrompt)
  };
}

async function mutate(parent: Candidate, ctx: Ctx, rand: () => number = Math.random): Promise<Candidate[]> {
  const r = rand();
  if (r < 0.10 && ctx.leaderboard && ctx.leaderboard.length >= 2) {
    const op = OPERATORS[Math.floor(rand() * OPERATORS.length)];
    const child = await llmRewrite(parent, ctx, op);
    if (child) return [child];
  }
  const op = OPERATORS[Math.floor(rand() * OPERATORS.length)];
  return await op.apply(parent, ctx);
}

export { OPERATORS, mutate };
export type { Candidate, Ctx, Op };
