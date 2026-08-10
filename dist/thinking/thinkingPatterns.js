// thinking/thinkingPatterns.ts
// concrete, citable moves pulled from how real geniuses solve hard problems.
// Each entry: name, signature move, when to use, instruction template, exemplar.
export const PATTERNS = [
    {
        name: 'feynman-decompose',
        thinker: 'Richard Feynman',
        move: 'Strip the problem to its physical mechanism before you touch a single variable.',
        when: 'problem feels too abstract or you are drowning in formalism',
        template: 'Before solving, restate the problem in plain physical terms. What is actually happening? If you cannot, the problem is not yet understood.',
        exemplar: "Feynman's QED path integrals: he replaced abstract amplitudes with 'little arrows spinning in time' so a student could see why the answer was what it was."
    },
    {
        name: 'feynman-elaborate',
        thinker: 'Richard Feynman',
        move: 'If you cannot explain it to a curious child, you have not solved it.',
        when: 'you think you are done but the result feels magic',
        template: 'Restate your final answer as if explaining to a curious five-year-old. If you cannot, your solution has a hidden hand-wave. Find it and fix it.',
        exemplar: "From 'Surely You\\'re Joking, Mr. Feynman' — the difference between knowing a thing and knowing the name of a thing."
    },
    {
        name: 'erdos-counterexample',
        thinker: 'Paul Erdős',
        move: 'For every claim, try to break it. The proof is what survives.',
        when: 'you have a candidate answer and want to be sure',
        template: 'For your main claim, try to construct a counter-example. If you find one, your claim is wrong — fix it. If you cannot find one in 3 attempts, the claim is likely true.',
        exemplar: "Erdős's probabilistic method: prove existence by showing the expected count of a bad object is less than one."
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
        exemplar: 'Ramanujan computed partitions of numbers by hand to spot identities.'
    },
    {
        name: 'ramanujan-formalize-later',
        thinker: 'Srinivasa Ramanujan',
        move: 'A correct conjecture is worth more than a wrong proof. State the answer, then find a proof.',
        when: 'time pressure, or you can see the answer but not the chain',
        template: 'Write your best guess at the closed-form answer FIRST. Then justify it.',
        exemplar: "Many of Ramanujan's 3000+ theorems were stated without proof in his letters to Hardy."
    },
    {
        name: 'poincare-incubate',
        thinker: 'Henri Poincaré',
        move: 'Hit the wall, walk away, then ask: what form would the answer have to take?',
        when: 'you have been working for a long time with no progress',
        template: 'Stop. State explicitly: if a solution exists, what shape would it be? Then attempt only that shape.',
        exemplar: 'Poincaré solved the Fuchsian function problem while boarding a bus in Coutances.'
    },
    {
        name: 'archimedes-analogy',
        thinker: 'Archimedes',
        move: 'Borrow the geometry of a known object to reason about a new one.',
        when: 'the problem involves areas, volumes, or spatial reasoning',
        template: 'Find a simpler, similar shape whose area or volume you know. Decompose the new shape into that shape plus a correction.',
        exemplar: 'Archimedes bounded π by inscribing and circumscribing polygons of 96 sides.'
    },
    {
        name: 'ttao-lemma-decompose',
        thinker: 'Terence Tao',
        move: 'A hard problem is a stack of small lemmas. Find one, prove it, then move to the next.',
        when: 'the problem is more than 2 pages of reasoning',
        template: 'Do not try to solve the whole problem. State the smallest lemma that, if true, would unblock the next step. Prove that lemma. Repeat.',
        exemplar: 'Tao on the prime tuple conjecture: years of work on progressively smaller lemmas.'
    },
    {
        name: 'knuth-worst-case',
        thinker: 'Donald Knuth',
        move: 'Worst case is the truth. Average case is a lie you tell to feel better.',
        when: 'you are about to commit to a design decision',
        template: 'Before deciding, ask: what is the worst possible input? If my answer degrades gracefully, it is good. If it crashes, fix it.',
        exemplar: "Knuth's TAOCP Vol 3: sorting and searching, analyzed down to the exact operation count for every input shape."
    },
    {
        name: 'knuth-literate',
        thinker: 'Donald Knuth',
        move: 'Write the program in English first. The code is the last step.',
        when: 'the problem is non-trivial code, not a one-liner',
        template: 'In plain prose, describe: (1) what the input is, (2) what invariants must hold at every step, (3) what the output is, (4) the order of operations.',
        exemplar: 'Knuth invented "literate programming" because the code without the explanation is the wrong artifact.'
    },
    {
        name: 'sagan-baloney-detect',
        thinker: 'Carl Sagan',
        move: 'A claim that cannot in principle be proven wrong is worthless. Demand the test.',
        when: 'the answer feels persuasive but unsupported',
        template: 'For your main claim, state: what observation, if seen, would prove it false?',
        exemplar: "Sagan's 'baloney detection kit': independent confirmation, quantify, chain of argument, Occam's razor, falsifiability."
    },
    {
        name: 'curie-isolate-variables',
        thinker: 'Marie Curie',
        move: 'When confused, hold everything constant and vary one thing.',
        when: 'the system has many interacting parts',
        template: 'List the variables. Hold all but one fixed. Predict what happens as you vary that one. Then run the experiment.',
        exemplar: 'Curie isolated radium from tons of pitchblende by varying the chemical separation step.'
    },
    {
        name: 'turing-machines-on-machines',
        thinker: 'Alan Turing',
        move: 'When stuck on a system, ask: what would a simpler version of this system do? Then escalate.',
        when: 'the problem is too large to reason about directly',
        template: 'State the simplest possible version of this problem. Solve that. Then state what changes as you scale to the real problem.',
        exemplar: 'Turing reduced the halting problem to a simpler machine to prove the general impossibility.'
    },
    {
        name: 'kahneman-system2',
        thinker: 'Daniel Kahneman',
        move: 'If the answer came instantly, you are guessing. Slow down.',
        when: 'you wrote the answer in under 30 seconds',
        template: 'Pause. If your first answer arrived without conscious effort, mark it as a hypothesis. Now deliberately look for what would make it wrong.',
        exemplar: "Kahneman's System 1 vs System 2 — many reasoning failures are System 1 mistakes presented as conclusions."
    },
    {
        name: 'kahneman-wysiati',
        thinker: 'Daniel Kahneman',
        move: 'What you see is all there is. The absence of evidence is not evidence of absence.',
        when: 'you are tempted to claim "no counter-example exists"',
        template: "If your evidence base is small, do not conclude 'X is false'. Conclude 'I have not seen X'.",
        exemplar: 'WYSIATI — the most common bias in expert reasoning.'
    },
    {
        name: 'lamarr-frequency-hop',
        thinker: 'Hedy Lamarr',
        move: 'Steal the trick from a different field. The best ideas are usually imported.',
        when: 'all in-domain approaches have failed',
        template: 'State the obstacle in one sentence. Now list 3 unrelated fields. For each, ask: how would that field solve this?',
        exemplar: 'Lamarr applied piano-roll frequency hopping to torpedo guidance in 1942.'
    },
    {
        name: 'mcclintock-anomaly',
        thinker: 'Barbara McClintock',
        move: 'The one thing that does not fit is the most important thing.',
        when: 'data disagrees with your model',
        template: 'Find the one observation in your evidence that your current model cannot explain. Treat it as the lead, not the noise.',
        exemplar: 'McClintock noticed color-stripping patterns in maize; following the anomaly led to transposons, a Nobel in 1983.'
    },
    {
        name: 'fuller-tensile-integrity',
        thinker: 'Buckminster Fuller',
        move: 'Look for the structure that does the most with the least.',
        when: 'your design has too many pieces',
        template: 'List every component. For each, ask: if I removed it, would the system still work? If yes, remove it.',
        exemplar: "Fuller's geodesic dome: a sphere of triangles, every strut in pure tension or compression."
    },
    {
        name: 'lovelace-poetical-science',
        thinker: 'Ada Lovelace',
        move: 'Mix the metaphor with the mechanism. The best explanation uses an image and a rule.',
        when: 'the answer is technically correct but unmemorable',
        template: 'After you solve the problem, find one metaphor that captures the structure.',
        exemplar: "Lovelace's 'Notes' on Babbage's Analytical Engine."
    },
    {
        name: 'dijkstra-structured-program',
        thinker: 'Edsger Dijkstra',
        move: 'The structure of the program is the proof. If the structure is not clean, the proof is wrong.',
        when: 'code is getting tangled, or reasoning has loops',
        template: 'Stop. Write the program or proof in the most boring, structured form possible.',
        exemplar: "Dijkstra's EWD249: 'The humble programmer'."
    },
    {
        name: 'dijkstra-proof-by-construction',
        thinker: 'Edsger Dijkstra',
        move: 'If the proof requires a clever trick, find a proof that does not.',
        when: 'your solution has a "magic" step',
        template: 'Identify the step in your argument that you cannot explain intuitively. Replace it.',
        exemplar: "Dijkstra's shortest-path algorithm is constructive: it builds the path."
    },
    {
        name: 'neumann-parallel-drafts',
        thinker: 'John von Neumann',
        move: 'Do not commit to one path. Carry 2-3 draft solutions in parallel.',
        when: 'you are about to bet the answer on a single approach',
        template: 'Sketch 2 different solutions. Do not refine either yet. Then test each against the hardest input you can construct.',
        exemplar: 'Von Neumann would hold 2-3 proofs of a theorem in his head at once.'
    },
    {
        name: 'hard-sf-check',
        thinker: 'Various (Fermi estimation)',
        move: 'Plausibility is not enough. Quantify the scale.',
        when: 'your answer is a number, an order of magnitude, or a feasibility claim',
        template: 'Estimate the order of magnitude. Is it between 0.01x and 100x what intuition says?',
        exemplar: 'Fermi estimates: how many piano tuners in Chicago?'
    },
    {
        name: 'skeptic-stance',
        thinker: 'Default (Sagan + Kahneman blend)',
        move: 'Before stating your answer, attack it as if you were a hostile reviewer.',
        when: 'final answer is about to be delivered',
        template: 'Pretend you are reviewing this answer for a journal. List 3 reasons it could be wrong.',
        exemplar: 'Self-rubric — steelman the opposition before publishing.'
    },
    {
        name: 'fable-think-format',
        thinker: 'Claude reasoning models',
        move: 'Think in a visible block, then answer. Explicitly catch yourself when you slip.',
        when: 'any hard problem where quality of reasoning matters more than speed',
        template: 'Use this format exactly:\n\n<thinking>\n[your raw reasoning]\n[explicitly note "actually…" or "wait…" when you change your mind]\n[end with the load-bearing claim you will defend]\n</thinking>\n\n[final answer]',
        exemplar: 'Visible think block is the rigor.'
    },
    {
        name: 'classify-then-route',
        thinker: 'Workflow synthesis',
        move: 'Classify the problem first. Different problem classes want different thinking moves.',
        when: 'before tackling anything non-trivial',
        template: 'In one sentence, classify this problem: ASSERTION, STUCK, BUILD, or ANOMALY.',
        exemplar: 'A model that classifies before acting wastes 3-5x less effort on the wrong mode.'
    },
    {
        name: 'neumann-internal-critic',
        thinker: 'John von Neumann',
        move: 'Carry a hostile internal critic. The first draft is the suspect, not the verdict.',
        when: 'any time you have produced a candidate answer',
        template: 'Imagine a hostile critic who has 60 seconds to destroy it. What is the most embarrassing mistake? Patch it.',
        exemplar: 'Stop when the same critic returns with the same complaint twice.'
    },
    {
        name: 'explicit-uncertainty',
        thinker: 'Calibration research',
        move: 'Tag every claim with its confidence.',
        when: 'your answer has more than 3 claims',
        template: 'For each load-bearing claim, write: CLAIM, CONFIDENCE, GROUNDS.',
        exemplar: 'Forced calibration catches the "looks certain, actually a guess" failure mode.'
    },
    {
        name: 'eliminate-systematically',
        thinker: 'Standard test-taking technique',
        move: 'For multiple choice, kill the wrong answers one at a time before guessing.',
        when: 'multiple-choice question where more than one choice is plausible',
        template: 'For each option, write one sentence on why it could be wrong.',
        exemplar: 'Powers of 2, 3, 5, 7, 11 — the next is 13, not 15 or 20.'
    },
    {
        name: 'sequence-mine',
        thinker: 'Working mathematicians',
        move: 'For a number sequence, mine it for structure before guessing.',
        when: 'given a sequence of numbers and asked for the next term',
        template: 'Compute first differences, second differences, ratios, alternate subsequences, sums of pairs.',
        exemplar: '1, 8, 27 are 1 cubed, 2 cubed, 3 cubed — the next is 64.'
    },
    {
        name: 'extract-constraints',
        thinker: 'Polya + algebra tradition',
        move: 'For a word problem, lift every quantitative claim into an equation before solving.',
        when: 'the problem is stated in natural language with numbers, rates, prices, distances, or times',
        template: 'List every quantitative fact as a separate equation or relation. Introduce a symbol for every unknown.',
        exemplar: 'Pen + notebook = $1.10, notebook $1.00 more than pen — pen costs $0.05.'
    },
    {
        name: 'commit-and-defend',
        thinker: 'Game-show strategy',
        move: 'Make the model commit to a single answer, with the reasoning summarized.',
        when: 'final-answer questions: multiple choice, true/false, a single number, a single name',
        template: 'Restate your top pick. State 1-2 supporting facts. State the strongest reason it might be wrong. Output: ANSWER: <...>',
        exemplar: 'Forces a clean output that is parseable.'
    }
];
export const PATTERN_BY_NAME = Object.fromEntries(PATTERNS.map(p => [p.name, p]));
export function samplePatterns(n, rand = Math.random) {
    const out = [];
    const pool = [...PATTERNS];
    for (let i = 0; i < n && pool.length; i++) {
        const k = Math.floor(rand() * pool.length);
        out.push(pool.splice(k, 1)[0]);
    }
    return out;
}
export function composePrompt(patterns, opts = {}) {
    const tone = opts.tone || 'neutral';
    const intro = tone === 'didactic'
        ? 'You will work through this problem step by step. Use every technique listed below, in order. After each, briefly note what you learned.'
        : tone === 'socratic'
            ? 'Before each step below, ask yourself the question it implies. Answer the question out loud. Then act.'
            : tone === 'terse'
                ? 'Apply each technique. Be concise — one short paragraph per step. No preamble.'
                : 'For each technique below, follow the instruction. Do not skip any.';
    const blocks = patterns
        .map((p, i) => `${i + 1}. ${p.name} (${p.thinker}) — ${p.move}\n   ${p.template}`)
        .join('\n\n');
    return `${intro}\n\n${blocks}\n\nFinal answer only after all steps above. Output it as your last paragraph.`;
}
export function fingerprint(prompt) {
    const pat = patternsIn(prompt);
    const firstLine = String(prompt || '').split('\n')[0] || '';
    let tone = 'neutral';
    if (/socratic/i.test(firstLine) || /ask yourself the question/i.test(firstLine))
        tone = 'socratic';
    else if (/didactic/i.test(firstLine) || /step by step/i.test(firstLine))
        tone = 'didactic';
    else if (/terse/i.test(firstLine) || /concise/i.test(firstLine))
        tone = 'terse';
    return {
        n: pat.length,
        thinkers: [...new Set(pat.map(p => p.thinker))].sort(),
        names: pat.map(p => p.name),
        tone
    };
}
export function patternsIn(prompt) {
    const out = [];
    for (const p of PATTERNS) {
        if (prompt.includes(p.name))
            out.push(p);
    }
    return out;
}
export function fableMetaPrompt(opts = {}) {
    const profile = opts.profile || 'default';
    const intensity = opts.intensity || 'medium';
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
export function fableFingerprint(prompt) {
    const hasFable = /fable-think-format/.test(prompt) || /<thinking>/.test(prompt);
    const hasClassify = /classify-then-route/.test(prompt) || /CLASSIFY/.test(prompt);
    let tone = 'meta';
    if (/<thinking>/.test(prompt) || /STAGE \d/.test(prompt))
        tone = 'meta';
    return {
        n: patternsIn(prompt).length,
        thinkers: [...new Set(patternsIn(prompt).map(p => p.thinker))].sort(),
        names: patternsIn(prompt).map(p => p.name),
        tone,
        hasFable,
        hasClassify
    };
}
