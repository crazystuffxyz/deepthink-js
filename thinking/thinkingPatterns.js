// thinking/thinkingPatterns.js — concrete, citable moves pulled from how real geniuses solve hard problems.
// Each entry has: name, signature move, when to use, instruction template, exemplar (where possible).
'use strict';

// helper: how to call a pattern inside the meta-prompt composer
export const PATTERNS = [
  {
    name: 'feynman-decompose',
    thinker: 'Richard Feynman',
    move: 'Strip the problem to its physical mechanism before you touch a single variable.',
    when: 'problem feels too abstract or you are drowning in formalism',
    template: 'Before solving, restate the problem in plain physical terms. What is actually happening? If you cannot, the problem is not yet understood.',
    exemplar: 'Feynman\'s QED path integrals: he replaced abstract amplitudes with "little arrows spinning in time" so a student could see why the answer was what it was.'
  },
  {
    name: 'feynman-elaborate',
    thinker: 'Richard Feynman',
    move: 'If you cannot explain it to a curious child, you have not solved it.',
    when: 'you think you are done but the result feels magic',
    template: 'Restate your final answer as if explaining to a curious five-year-old. If you cannot, your solution has a hidden hand-wave. Find it and fix it.',
    exemplar: 'From "Surely You\'re Joking, Mr. Feynman" — the difference between knowing a thing and knowing the name of a thing.'
  },
  {
    name: 'erdos-counterexample',
    thinker: 'Paul Erdős',
    move: 'For every claim, try to break it. The proof is what survives.',
    when: 'you have a candidate answer and want to be sure',
    template: 'For your main claim, try to construct a counter-example. If you find one, your claim is wrong — fix it. If you cannot find one in 3 attempts, the claim is likely true.',
    exemplar: 'Erdős\'s probabilistic method: prove existence by showing the expected count of a bad object is less than one.'
  },
  {
    name: 'erdos-book',
    thinker: 'Paul Erdős',
    move: 'A proof is something a divine being wrote in The Book. Your job is to recover it.',
    when: 'the problem is classical or has an elegant closed form',
    template: 'Before long algebra, ask: what is the cleanest possible statement of the answer? Then work backward from that to the proof.',
    exemplar: 'Erdős often announced "This is from The Book" and then produced a 2-line argument where a brute-force attack would have been 2 pages.'
  },
  {
    name: 'ramanujan-intuition',
    thinker: 'Srinivasa Ramanujan',
    move: 'Trust the example. The pattern reveals the general form before the proof does.',
    when: 'you are stuck on a closed-form answer',
    template: 'Compute 4-5 numerical examples. Look at them side by side. What pattern jumps out? State the pattern, then prove it.',
    exemplar: 'Ramanujan computed partitions of numbers by hand to spot identities (1 = 1, 5 = 5+1+... = 3+1+1+...).'
  },
  {
    name: 'ramanujan-formalize-later',
    thinker: 'Srinivasa Ramanujan',
    move: 'A correct conjecture is worth more than a wrong proof. State the answer, then find a proof.',
    when: 'time pressure, or you can see the answer but not the chain',
    template: 'Write your best guess at the closed-form answer FIRST. Then justify it. If the answer is right and the proof is shaky, mark the proof as the work to do.',
    exemplar: 'Many of Ramanujan\'s 3000+ theorems were stated without proof in his letters to Hardy; proofs came later.'
  },
  {
    name: 'poincare-incubate',
    thinker: 'Henri Poincaré',
    move: 'Hit the wall, walk away, then ask: what form would the answer have to take?',
    when: 'you have been working for a long time with no progress',
    template: 'Stop. State explicitly: if a solution exists, what shape would it be? A closed form? A counter-example? An existence proof? Then attempt only that shape.',
    exemplar: 'Poincaré solved the Fuchsian function problem while boarding a bus in Coutances — after weeks of failed attacks he had defined the shape he wanted, and the answer came in a flash.'
  },
  {
    name: 'archimedes-analogy',
    thinker: 'Archimedes',
    move: 'Borrow the geometry of a known object to reason about a new one.',
    when: 'the problem involves areas, volumes, or spatial reasoning',
    template: 'Find a simpler, similar shape whose area or volume you know. Decompose the new shape into that shape plus a correction. Bound the correction.',
    exemplar: 'Archimedes bounded π by inscribing and circumscribing polygons of 96 sides — straight lines around a curve.'
  },
  {
    name: 'ttao-lemma-decompose',
    thinker: 'Terence Tao',
    move: 'A hard problem is a stack of small lemmas. Find one, prove it, then move to the next.',
    when: 'the problem is more than 2 pages of reasoning',
    template: 'Do not try to solve the whole problem. State the smallest lemma that, if true, would unblock the next step. Prove that lemma. Repeat.',
    exemplar: 'Tao on the prime tuple conjecture: years of work on progressively smaller lemmas, each one only useful in combination with the others.'
  },
  {
    name: 'knuth-worst-case',
    thinker: 'Donald Knuth',
    move: 'Worst case is the truth. Average case is a lie you tell to feel better.',
    when: 'you are about to commit to a design decision',
    template: 'Before deciding, ask: what is the worst possible input? If my answer degrades gracefully in that case, it is good. If it crashes, fix it before continuing.',
    exemplar: 'Knuth\'s TAOCP Vol 3: sorting and searching, analyzed down to the exact operation count for every input shape.'
  },
  {
    name: 'knuth-literate',
    thinker: 'Donald Knuth',
    move: 'Write the program in English first. The code is the last step.',
    when: 'the problem is non-trivial code, not a one-liner',
    template: 'In plain prose, describe: (1) what the input is, (2) what invariants must hold at every step, (3) what the output is, (4) the order of operations. Only after all four are stated, write code.',
    exemplar: 'Knuth invented "literate programming" because the code without the explanation is the wrong artifact.'
  },
  {
    name: 'sagan-baloney-detect',
    thinker: 'Carl Sagan',
    move: 'A claim that cannot in principle be proven wrong is worthless. Demand the test.',
    when: 'the answer feels persuasive but unsupported',
    template: 'For your main claim, state: what observation, if seen, would prove it false? If you cannot name one, the claim is not yet a claim — it is a hope.',
    exemplar: 'Sagan\'s "baloney detection kit": independent confirmation, quantify, chain of argument, Occam\'s razor, falsifiability.'
  },
  {
    name: 'curie-isolate-variables',
    thinker: 'Marie Curie',
    move: 'When confused, hold everything constant and vary one thing.',
    when: 'the system has many interacting parts',
    template: 'List the variables. Hold all but one fixed. Predict what happens as you vary that one. Then run the experiment. Only then vary the second.',
    exemplar: 'Curie isolated radium from tons of pitchblende by varying the chemical separation step while keeping the source mineral constant.'
  },
  {
    name: 'turing-machines-on-machines',
    thinker: 'Alan Turing',
    move: 'When stuck on a system, ask: what would a simpler version of this system do? Then escalate.',
    when: 'the problem is too large to reason about directly',
    template: 'State the simplest possible version of this problem (smallest input, weakest constraints, fewest entities). Solve that. Then state what changes as you scale to the real problem. Apply the differences.',
    exemplar: 'Turing reduced the halting problem to a simpler machine to prove the general impossibility.'
  },
  {
    name: 'kahneman-system2',
    thinker: 'Daniel Kahneman',
    move: 'If the answer came instantly, you are guessing. Slow down.',
    when: 'you wrote the answer in under 30 seconds',
    template: 'Pause. If your first answer arrived without conscious effort, mark it as a hypothesis. Now deliberately look for what would make it wrong.',
    exemplar: 'Kahneman\'s System 1 (fast) vs System 2 (slow) — many reasoning failures are System 1 mistakes presented as conclusions.'
  },
  {
    name: 'kahneman-wysiati',
    thinker: 'Daniel Kahneman',
    move: 'What you see is all there is. The absence of evidence is not evidence of absence.',
    when: 'you are tempted to claim "no counter-example exists"',
    template: 'If your evidence base is small, do not conclude "X is false". Conclude "I have not seen X". The difference matters.',
    exemplar: 'WYSIATI — the most common bias in expert reasoning; overconfidence from incomplete search.'
  },
  {
    name: 'lamarr-frequency-hop',
    thinker: 'Hedy Lamarr',
    move: 'Steal the trick from a different field. The best ideas are usually imported.',
    when: 'all in-domain approaches have failed',
    template: 'State the obstacle in one sentence. Now list 3 unrelated fields. For each, ask: how would that field solve this? Adapt the most promising.',
    exemplar: 'Lamarr applied piano-roll frequency hopping (musical automation) to torpedo guidance, patenting spread-spectrum communication in 1942.'
  },
  {
    name: 'mcclintock-anomaly',
    thinker: 'Barbara McClintock',
    move: 'The one thing that does not fit is the most important thing. Pay attention to anomalies.',
    when: 'data disagrees with your model',
    template: 'Find the one observation in your evidence that your current model cannot explain. Treat it as the lead, not the noise. Revise the model to fit it.',
    exemplar: 'McClintock noticed color-stripping patterns in maize that did not fit Mendelian inheritance. Following the anomaly led to transposons ("jumping genes"), a Nobel in 1983.'
  },
  {
    name: 'fuller-tensile-integrity',
    thinker: 'Buckminster Fuller',
    move: 'Look for the structure that does the most with the least. Eliminate components that do not pull their weight.',
    when: 'your design has too many pieces',
    template: 'List every component. For each, ask: if I removed it, would the system still work? If yes, remove it. Then ask: are any remaining components now redundant?',
    exemplar: 'Fuller\'s geodesic dome: a sphere of triangles, every strut in pure tension or compression, no bending. Minimum material, maximum strength.'
  },
  {
    name: 'lovelace-poetical-science',
    thinker: 'Ada Lovelace',
    move: 'Mix the metaphor with the mechanism. The best explanation uses an image and a rule.',
    when: 'the answer is technically correct but unmemorable',
    template: 'After you solve the problem, find one metaphor that captures the structure. Pair the metaphor with the rule. The reader should see both at once.',
    exemplar: 'Lovelace\'s "Notes" on Babbage\'s Analytical Engine: "the engine can compose elaborate and scientific pieces of music of any degree of complexity" — the first algorithm-as-art argument.'
  },
  {
    name: 'dijkstra-structured-program',
    thinker: 'Edsger Dijkstra',
    move: 'The structure of the program is the proof. If the structure is not clean, the proof is wrong.',
    when: 'code is getting tangled, or reasoning has loops',
    template: 'Stop. Write the program or proof in the most boring, structured form possible. Each step should do one thing. If you cannot make it boring, the design is wrong.',
    exemplar: 'Dijkstra\'s EWD249: "The humble programmer" — competence over cleverness, simplicity as a discipline.'
  },
  {
    name: 'dijkstra-proof-by-construction',
    thinker: 'Edsger Dijkstra',
    move: 'If the proof requires a clever trick, find a proof that does not.',
    when: 'your solution has a "magic" step',
    template: 'Identify the step in your argument that you cannot explain intuitively. If it relies on a coincidence, replace it. Constructive proofs over existential proofs.',
    exemplar: 'Dijkstra\'s shortest-path algorithm is constructive: it builds the path, it does not prove one exists by some other means.'
  },
  {
    name: 'neumann-parallel-drafts',
    thinker: 'John von Neumann',
    move: 'Do not commit to one path. Carry 2-3 draft solutions in parallel. Pick the one that survives the most tests.',
    when: 'you are about to bet the answer on a single approach',
    template: 'Sketch 2 different solutions. Do not refine either yet. Then test each against the hardest input you can construct. The one that fails less is your candidate. Only then refine.',
    exemplar: 'Von Neumann would hold 2-3 proofs of a theorem in his head at once and discard the ones that broke under edge cases.'
  },
  {
    name: 'hard-sf-check',
    thinker: 'Various (science fiction writers as informal physics testers)',
    move: 'Plausibility is not enough. Quantify the scale.',
    when: 'your answer is a number, an order of magnitude, or a feasibility claim',
    template: 'Estimate the order of magnitude. Is it between 0.01x and 100x what intuition says? If not, you have a unit error or a wrong model. Find it.',
    exemplar: 'Fermi estimates: how many piano tuners in Chicago? The answer is meaningful only when you commit to orders of magnitude.'
  },
  {
    name: 'skeptic-stance',
    thinker: 'Default (Sagan + Kahneman blend)',
    move: 'Before stating your answer, attack it as if you were a hostile reviewer.',
    when: 'final answer is about to be delivered',
    template: 'Pretend you are reviewing this answer for a journal. List 3 reasons it could be wrong. If any of them is plausible, fix the answer. If none of them is, you are done.',
    exemplar: 'Self-rubric — steelman the opposition before publishing.'
  },
  {
    name: 'fable-think-format',
    thinker: 'Fable 5 (Claude family — best public reasoning model)',
    move: 'Think in a visible block, then answer. Explicitly catch yourself when you slip.',
    when: 'any hard problem where quality of reasoning matters more than speed',
    template: 'Use this format exactly:\n\n<thinking>\n[your raw reasoning: questions, what you considered, what you rejected, why]\n[explicitly note "actually…" or "wait…" when you change your mind]\n[end with the load-bearing claim you will defend]\n</thinking>\n\n[final answer, in plain prose]\n\nDo not skip the think block. Do not let the answer leak into the think block.',
    exemplar: 'Fable 5 / Claude 4.5 thinking traces consistently show: (1) restate, (2) try the obvious, (3) notice a flaw, (4) re-derive, (5) state the corrected claim, (6) verify with a concrete example. The visible think block is the rigor.'
  },
  {
    name: 'classify-then-route',
    thinker: 'Workflow synthesis (Feynman + Poincaré + Tao)',
    move: 'Classify the problem first. Different problem classes want different thinking moves.',
    when: 'before tackling anything non-trivial',
    template: 'In one sentence, classify this problem:\n  - ASSERTION: someone is about to accept a claim.\n  - STUCK: you have been thinking with no progress.\n  - BUILD: you are designing or implementing a system.\n  - ANOMALY: data does not fit a model.\nThen apply the matching moves:\n  ASSERTION → baloney-detect, counterexample, decompose.\n  STUCK → incubate, form-first, compress.\n  BUILD → worst-case, parallel-drafts, compress.\n  ANOMALY → anomaly-attention, form-first, baloney-detect.\nAlways end with a System-2 trigger (slow re-check).',
    exemplar: 'A model that classifies before acting wastes 3-5x less effort on the wrong mode. Most reasoning errors are mode-mismatch errors.'
  },
  {
    name: 'neumann-internal-critic',
    thinker: 'John von Neumann',
    move: 'Carry a hostile internal critic. The first draft is the suspect, not the verdict.',
    when: 'any time you have produced a candidate answer',
    template: 'You wrote a draft. Now imagine a hostile critic who has 60 seconds to destroy it. What is the most embarrassing mistake they could find? Patch it. Then imagine a second critic. Patch again. Stop when the same critic returns with the same complaint twice.',
    exemplar: 'Von Neumann held 2-3 parallel proofs in his head; whichever survived internal attack was the candidate. The "internal critic" is the cheap computational proxy for an entire review board.'
  },
  {
    name: 'explicit-uncertainty',
    thinker: 'Calibration research (Kahneman + others)',
    move: 'Tag every claim with its confidence. A 70% claim is different from a 95% claim.',
    when: 'your answer has more than 3 claims, or any claim feels too smooth',
    template: 'For each load-bearing claim, write: CLAIM: [statement]  CONFIDENCE: [0-100%]  GROUNDS: [why not lower, why not higher].\nIf a claim is below 70%, either find grounds to raise it or flag it as a known weak link in the final answer.',
    exemplar: 'Forced calibration catches the "looks certain, actually a guess" failure mode. Most confident-sounding expert errors are uncalibrated 60% claims that have been dressed as 95% claims.'
  },
  {
    name: 'eliminate-systematically',
    thinker: 'Standard test-taking technique (no single namesake)',
    move: 'For multiple choice, kill the wrong answers one at a time before guessing.',
    when: 'multiple-choice question where more than one choice is plausible and only one is right',
    template: 'For each option, write one sentence on why it could be wrong. If the option survives the test, keep it; if not, eliminate it. The last option standing is your answer. If two survive, the question is ambiguous — pick the one with the most direct reading of the question stem. Never pick the option that requires you to assume the question is "tricky".',
    exemplar: 'Powers of 2, 3, 5, 7, 11 — the next is 13, not 15 or 20. The "feels right" trap is 15 (next multiple of 5). The mechanical check kills it: every prior term is prime, only 13 continues that.'
  },
  {
    name: 'sequence-mine',
    thinker: 'Working mathematicians (sequence analysis is a craft)',
    move: 'For a number sequence, mine it for structure before guessing.',
    when: 'given a sequence of numbers and asked for the next term(s)',
    template: 'Compute in order: (1) first differences, (2) second differences, (3) ratios of consecutive terms, (4) alternate subsequences, (5) sums of pairs, (6) digit sums, (7) polynomial fit on indices 1, 2, 3. If any operation makes the result constant, that is the rule. If multiple rules fit, prefer the simplest (smallest polynomial, smallest number of operations). Never commit to a rule until you have computed the next term with it and seen whether it lands on one of the given choices.',
    exemplar: '1, 8, 27 are 1 cubed, 2 cubed, 3 cubed — the next is 64 (4 cubed). The constant-first-difference heuristic fails here; the polynomial-in-index heuristic wins. Always test against the choices before locking in.'
  },
  {
    name: 'extract-constraints',
    thinker: 'Polya + algebra tradition',
    move: 'For a word problem, lift every quantitative claim into an equation before solving.',
    when: 'the problem is stated in natural language with numbers, rates, prices, distances, or times',
    template: 'List every quantitative fact the problem gives you as a separate equation or relation. Introduce a symbol for every unknown. THEN solve the system. Do not start solving until you have at least as many equations as unknowns. If you are short, you missed a fact — reread the problem, slowly.',
    exemplar: '"Pen + notebook = $1.10, notebook $1.00 more than pen" — the trap is to assume the pen costs $0.10. It costs $0.05. The two equations are p + n = 1.10, n = p + 1.00. Substitute: p + (p+1.00) = 1.10, so 2p = 0.10, p = 0.05.'
  },
  {
    name: 'commit-and-defend',
    thinker: 'Game-show strategy (final-answer lock-in)',
    move: 'Make the model commit to a single answer, with the reasoning summarized. No "it depends" or "could be".',
    when: 'final-answer questions: multiple choice, true/false, a single number, a single name',
    template: 'Restate your top pick in one sentence. State the 1-2 facts that most strongly support it. Then state the strongest reason it might be wrong. If the supporting facts are stronger than the objection, lock it in. Output the final answer on its own line in the form ANSWER: <number/word/letter>.',
    exemplar: 'Forces a clean output. The prose can be elaborate; the ANSWER line is what gets graded. This pattern is what makes the answer parseable.'
  }
];

// quick lookup by name
export const PATTERN_BY_NAME = Object.fromEntries(PATTERNS.map(p => [p.name, p]));

// pick N random patterns for candidate generation. tag them so the prompt records its lineage.
export function samplePatterns(n, rand = Math.random) {
  const out = [];
  const pool = [...PATTERNS];
  for (let i = 0; i < n && pool.length; i++) {
    const k = Math.floor(rand() * pool.length);
    out.push(pool.splice(k, 1)[0]);
  }
  return out;
}

// compose a system prompt by stitching N patterns. the prompt is the "genotype".
export function composePrompt(patterns, opts = {}) {
  const tone = opts.tone || 'neutral';
  const intro = tone === 'didactic'
    ? 'You will work through this problem step by step. Use every technique listed below, in order. After each, briefly note what you learned.'
    : tone === 'socratic'
    ? 'Before each step below, ask yourself the question it implies. Answer the question out loud. Then act.'
    : tone === 'terse'
    ? 'Apply each technique. Be concise — one short paragraph per step. No preamble.'
    : 'For each technique below, follow the instruction. Do not skip any.';

  const blocks = patterns.map((p, i) =>
    `${i + 1}. ${p.name} (${p.thinker}) — ${p.move}\n   ${p.template}`
  ).join('\n\n');

  return `${intro}\n\n${blocks}\n\nFinal answer only after all steps above. Output it as your last paragraph.`;
}

// short signature of a prompt: how many patterns, which thinkers, what tone
export function fingerprint(prompt) {
  const pat = patternsIn(prompt);
  // tone is encoded in the intro sentence. check the first line specifically.
  const firstLine = String(prompt || '').split('\n')[0];
  let tone = 'neutral';
  if (/socratic/i.test(firstLine) || /ask yourself the question/i.test(firstLine)) tone = 'socratic';
  else if (/didactic/i.test(firstLine) || /step by step/i.test(firstLine)) tone = 'didactic';
  else if (/terse/i.test(firstLine) || /concise/i.test(firstLine)) tone = 'terse';
  return {
    n: pat.length,
    thinkers: [...new Set(pat.map(p => p.thinker))].sort(),
    names: pat.map(p => p.name),
    tone
  };
}

// extract which patterns are referenced in a prompt
export function patternsIn(prompt) {
  const out = [];
  for (const p of PATTERNS) {
    if (prompt.includes(p.name)) out.push(p);
  }
  return out;
}

// fable-style meta prompt: combines the think-format with a problem classifier
// and a 4-stage workflow. this is the "scaffold" the evolution loop builds on top of.
export function fableMetaPrompt(opts = {}) {
  const profile = opts.profile || 'default';
  const intensity = opts.intensity || 'medium'; // low | medium | high

  // pick the secondary patterns by profile
  const secondary = profile === 'math'
    ? ['ramanujan-intuition', 'erdos-counterexample', 'feynman-decompose', 'sequence-mine', 'extract-constraints']
    : profile === 'code'
    ? ['knuth-worst-case', 'ttao-lemma-decompose', 'dijkstra-structured-program']
    : profile === 'logic'
    ? ['sagan-baloney-detect', 'mcclintock-anomaly', 'kahneman-system2']
    : profile === 'planning'
    ? ['feynman-decompose', 'knuth-worst-case', 'mcclintock-anomaly']
    : profile === 'puzzle'
    ? ['eliminate-systematically', 'sequence-mine', 'extract-constraints', 'commit-and-defend', 'fable-think-format']
    : ['feynman-decompose', 'erdos-counterexample', 'kahneman-system2', 'fable-think-format', 'commit-and-defend'];

  const stageWord = intensity === 'high' ? 'FIVE' : intensity === 'low' ? 'TWO' : 'FOUR';

  const stageInstr = intensity === 'high'
    ? `STAGE 1 — CLASSIFY: In one sentence, is this an ASSERTION, STUCK, BUILD, or ANOMALY problem?
STAGE 2 — DECOMPOSE: Restate in plain physical / operational terms. Define every term.
STAGE 3 — ATTACK: Try to break the obvious answer with a counter-example, an edge case, or a numerical sanity check.
STAGE 4 — RECONSIDER: Note where the attack succeeded. Update the answer.
STAGE 5 — VERIFY: Re-derive the corrected answer from scratch in one paragraph. Confirm each link in the chain.`
    : intensity === 'low'
    ? `STAGE 1 — RESTATE the problem in plain terms. STAGE 2 — ANSWER, then state the single most likely way your answer is wrong, and patch it.`
    : `STAGE 1 — CLASSIFY: ASSERTION, STUCK, BUILD, or ANOMALY?
STAGE 2 — RESTATE: the problem in plain physical / operational terms, with every term defined.
STAGE 3 — ATTACK: try to break your candidate answer with a counter-example or edge case.
STAGE 4 — VERIFY: re-derive the surviving answer from scratch. Confirm every link.`;

  return `You will solve the user's problem using a visible think block and a ${stageWord}-stage workflow.

OUTPUT FORMAT — required:

<thinking>
[your raw reasoning: questions, what you tried, what you rejected, why. When you change your mind, write "actually…" or "wait…". End with the load-bearing claim you will defend.]
</thinking>

[final answer in plain prose, with a one-line bottom line the user can quote]

Do not let the answer leak into the think block. Do not skip the think block.

WORKFLOW (apply in order):

${stageInstr}

APPLY THESE SECONDARY MOVES when relevant: ${secondary.map(n => PATTERN_BY_NAME[n]?.name || n).join(', ')}.

GENERAL RULES:
- Anchor every abstract term to a concrete referent (a number, a picture, a worked example).
- If you cannot state a counter-example to your main claim, your claim is not yet a claim — it is a hope.
- Treat being wrong as a procedural event, not a personal one. Self-correction in the think block is required, not optional.
- When done, the final answer is one short paragraph followed by a quotable bottom line.`;
}

// fingerprint for fableMetaPrompt
export function fableFingerprint(prompt) {
  const hasFable = /fable-think-format/.test(prompt) || /<thinking>/.test(prompt);
  const hasClassify = /classify-then-route/.test(prompt) || /CLASSIFY/.test(prompt);
  // fable prompts use STAGE labels and visible <thinking> — treat as 'meta' tone
  let tone = 'meta';
  if (/<thinking>/.test(prompt) || /STAGE \d/.test(prompt)) tone = 'meta';
  return {
    n: patternsIn(prompt).length,
    thinkers: [...new Set(patternsIn(prompt).map(p => p.thinker))].sort(),
    names: patternsIn(prompt).map(p => p.name),
    tone,
    hasFable,
    hasClassify
  };
}
