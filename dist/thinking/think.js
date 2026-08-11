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
//
// probe set (v2, 2026-08): added the techniques that measurably move hard
// reasoning — explicit heuristic strategy selection (Engel/Tao taxonomy),
// backward verification (RCoT: reconstruct the problem from the solution and
// diff against the original — catches misread constraints), and a structured
// scratchpad with explicit state (known facts / current state / goal /
// constraints). the synthesis pass now scores each probe for soundness and
// weights the final doc toward the sound passes (verifier-weighted voting).
// probes are fire-and-forget internal reasoning: hard output cap keeps
// gemma from writing an essay per probe (it ignores "be concise").
// num_predict (ollama-native) — max_tokens is ignored by the ollama client.
const PROBE_OPTS = { think: true, autoSystemPrompt: false, options: { num_predict: 300 } };
const THINK_SYS = 'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. ' +
    'Do NOT produce any code or final deliverable. Be short and concise.';
const STRATEGY_BODY = 'Name 3 candidate strategies from this taxonomy: invariants/monovariants, extremal principle, ' +
    'working backwards, extreme/special cases, symmetry, pigeonhole, coloring/parity, reformulation, ' +
    'induction, contradiction, case analysis, approximation-and-refine. ' +
    'Pick the most promising one for THIS problem and outline how it applies. ' +
    'If the problem is computational, name the algorithm class (DP, greedy, search, number theory, etc.).';
const BACKWARD_BODY = 'BACKWARD VERIFICATION: reconstruct the original problem from the solution you derived, ' +
    'then diff it against the actual problem statement. Identify every constraint you misread, ' +
    'missed, or added. Check: did you answer the question that was actually asked? ' +
    'Did you use every given condition? Are there edge cases (zero, negatives, boundaries) the solution ignores?';
const SCRATCHPAD_BODY = 'Work through the problem using a structured scratchpad with explicit state:\n' +
    'KNOWN FACTS: [every given condition, restated precisely]\n' +
    'GOAL: [what must be found, exactly]\n' +
    'CONSTRAINTS: [boundaries, domains, edge cases]\n' +
    'STEPS: [numbered computation, showing the actual arithmetic]\n' +
    'Then verify the result against every constraint.';
const TRAP_BODY = 'TRAP DETECTION: what is the most likely WRONG answer a careless solver would give, and why is it wrong? ' +
    'Identify the trap in this problem: misleading wording, tempting shortcut, common fallacy, ' +
    'or an answer that is "close but off by one". Then state what the correct approach must avoid. ' +
    'If the problem lists numbered choices, say which choice the trap points to and which is correct.';
const RESTATE_BODY = 'RESTATE the problem in your own words. What exactly is being asked? What is NOT being asked? ' +
    'List every given condition. Does the question use all of them, or is one a distractor? ' +
    'Check for ambiguity: could the wording support a different reading? If so, which reading is intended?';
// each probe: distinct lens on the same problem. same prefix, independent
// sampling (temp 0.7 gives path diversity; the synthesis repairs gaps).
const PROBES = {
    1: [
        {
            tag: 'analysis',
            body: 'Perform rigorous mathematical and logical decomposition. Decompose the request into primitive logical units. ' +
                'Isolate all explicit and implicit variables, state boundary conditions, and define constraints using extreme-case analysis. ' +
                'Proactively identify potential off-by-one errors and domain-boundary violations.',
            fmt: 'ANALYSIS:\n[3-6 bullet points max, no prose preamble]'
        },
        {
            tag: 'strategy',
            body: STRATEGY_BODY,
            fmt: 'STRATEGY:\n1. [candidate strategy]\n2. [candidate strategy]\n3. [candidate strategy]\nPICK: [chosen strategy + why]'
        },
        {
            tag: 'working',
            body: SCRATCHPAD_BODY,
            fmt: 'KNOWN FACTS:\nGOAL:\nCONSTRAINTS:\nSTEPS:\n1. [step]\n2. [step]'
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
            tag: 'strategy',
            body: STRATEGY_BODY,
            fmt: 'STRATEGY:\n1. [candidate strategy]\n2. [candidate strategy]\n3. [candidate strategy]\nPICK: [chosen strategy + why]'
        },
        {
            tag: 'working',
            body: SCRATCHPAD_BODY,
            fmt: 'KNOWN FACTS:\nGOAL:\nCONSTRAINTS:\nSTEPS:\n1. [step]\n   - [sub-detail]\n2. [step]'
        },
        {
            tag: 'backward',
            body: BACKWARD_BODY,
            fmt: 'RECONSTRUCTED PROBLEM:\n[restate the problem as the solution implies it]\nDIFF:\n- [constraint misread/missed/added]\n- [edge case ignored]'
        },
        {
            tag: 'trap',
            body: TRAP_BODY,
            fmt: 'TRAP:\n[the wrong answer a careless solver gives]\nWHY WRONG:\n[the fallacy]\nAVOID:\n[what the correct approach must not do]'
        },
        {
            tag: 'compute',
            body: 'If this problem involves probability, expected value, counting, or arithmetic: COMPUTE the answer explicitly. ' +
                'Enumerate the sample space, set up the equations, and evaluate them with actual numbers. ' +
                'Do NOT rely on symmetry, intuition, or qualitative reasoning — write out the real computation. ' +
                'If the problem is not computational, state the exact formula or procedure that would produce the answer.',
            fmt: 'COMPUTE:\n[explicit enumeration/equations with actual numbers]\nRESULT: [the computed value]'
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
            tag: 'strategy',
            body: STRATEGY_BODY,
            fmt: 'STRATEGY:\n1. [candidate strategy]\n2. [candidate strategy]\n3. [candidate strategy]\nPICK: [chosen strategy + why]'
        },
        {
            tag: 'working',
            body: SCRATCHPAD_BODY,
            fmt: 'KNOWN FACTS:\nGOAL:\nCONSTRAINTS:\nSTEPS:\n1. [step]\n   - [sub-detail]\n2. [step]'
        },
        {
            tag: 'backward',
            body: BACKWARD_BODY,
            fmt: 'RECONSTRUCTED PROBLEM:\n[restate the problem as the solution implies it]\nDIFF:\n- [constraint misread/missed/added]\n- [edge case ignored]'
        },
        {
            tag: 'sanity',
            body: 'Perform a rigorous, adversarial audit. Actively attempt to falsify the working: search for sign errors, ' +
                'division-by-zero vulnerabilities, boundary-condition leaks, and logical non-sequiturs. ' +
                'Do not restate assumptions — attack the calculations.',
            fmt: 'SANITY CHECK:\n[findings — max 6 bullet points]'
        },
        {
            tag: 'trap',
            body: TRAP_BODY,
            fmt: 'TRAP:\n[the wrong answer a careless solver gives]\nWHY WRONG:\n[the fallacy]\nAVOID:\n[what the correct approach must not do]'
        },
        {
            tag: 'restate',
            body: RESTATE_BODY,
            fmt: 'RESTATED:\n[the problem in your own words]\nNOT ASKED:\n[what is not being asked]\nCONDITIONS:\n[every given condition, one per line]'
        },
        {
            tag: 'alternative',
            body: 'Propose an alternative method — a different algorithmic approach, different framing, or different structure.',
            fmt: 'ALTERNATIVE:\n[max 100 words]'
        },
        {
            tag: 'compute',
            body: 'If this problem involves probability, expected value, counting, or arithmetic: COMPUTE the answer explicitly. ' +
                'Enumerate the sample space, set up the equations, and evaluate them with actual numbers. ' +
                'Do NOT rely on symmetry, intuition, or qualitative reasoning — write out the real computation. ' +
                'If the problem is not computational, state the exact formula or procedure that would produce the answer.',
            fmt: 'COMPUTE:\n[explicit enumeration/equations with actual numbers]\nRESULT: [the computed value]'
        }
    ]
};
const SYNTH_SYS = 'You are the internal reasoning coordinator. Below are independent analyses of the same problem, ' +
    'each produced by a separate reasoning pass. Consolidate them into ONE coherent reasoning document.\n\n' +
    'SCORING: for each pass, judge whether its reasoning is sound (correct math, no misread constraints, ' +
    'no logical leaps). Base the final document on the SOUND passes. Explicitly flag or discard unsound ones ' +
    'and say why. If passes disagree on a number, recompute the disputed step yourself and keep the correct value.\n\n' +
    'Be concise — no preamble, no repetition of what the passes already agree on.';
async function probe(callChat, systemContent, userContent, opts) {
    const r = await callChat([
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
    ], false, null, {
        ...opts,
        ...PROBE_OPTS,
        // PROBE_OPTS sets the DEFAULT cap (300); a caller (the synthesis
        // pass) may override with its own num_predict. merge caller-last.
        options: { ...PROBE_OPTS.options, ...(opts.options || {}) }
    });
    // gemma's thinking mode routes the whole response into `thinking` and
    // leaves `content` empty when the task says "internal reasoning only" —
    // the probe's deliverable IS that internal stream, so fall back to it.
    return ((r.content || '').trim() || (r.thinking || '').trim());
}
export async function runThink(callChat, inputText, depth, opts) {
    const results = {};
    if (depth <= 0)
        return results;
    const level = Math.min(Math.max(depth, 1), 3);
    const probesDef = PROBES[level];
    // wave 1: all probes in parallel — identical prefix, KV cache shared.
    // temp 0.7 for path diversity; independent draws, not a chain.
    const probeOpts = {
        ...opts,
        options: { ...(opts.options || {}), temperature: 0.7 }
    };
    // evolved guidance rides into the probes: the trained techniques are
    // reasoning moves, exactly what a probe should try. it's system-content,
    // so the KV-cache sharing across probes is preserved.
    const guide = opts.evolvedGuide || '';
    const probeSys = (p) => `${THINK_SYS}\n${p.body}\nOutput format:\n${p.fmt}` + (guide ? `\n\nAlso apply these techniques to your reasoning:\n${guide}` : '');
    const settled = await Promise.allSettled(probesDef.map((p) => probe(callChat, probeSys(p), inputText, probeOpts)));
    const chunks = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
            chunks.push(`${probesDef[i].tag.toUpperCase()}:\n${r.value}`);
        }
    });
    if (!chunks.length)
        return results; // every probe died — degrade to no think ctx
    // wave 2: one synthesis pass recombines the probes (the only sequential
    // step). lower temp for fidelity; bigger cap since it carries the whole doc.
    const synth = await probe(callChat, SYNTH_SYS, `Problem:\n${inputText}\n\nIndependent passes:\n\n${chunks.join('\n\n')}\n\nCONSOLIDATED:`, { ...opts, options: { ...(opts.options || {}), temperature: 0.3, num_predict: 600 } });
    if (synth)
        chunks.push(`CONSOLIDATED:\n${synth}`);
    results.analysis = chunks.join('\n\n');
    return results;
}
