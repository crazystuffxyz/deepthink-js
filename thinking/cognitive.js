// thinking/cognitive.ts
// 7-phase cognitive loop. Falls back to a single-pass when the model
// can't decide, never hangs.
import { tryParseJsonSafe } from '../parse/json.js';
import { z } from 'zod';
const ImpasseSchema = z.object({ impasse: z.boolean() });
const InsightSchema = z.object({ insight: z.boolean() });
const LoopSchema = z.object({ loop: z.boolean(), problem: z.string().optional() });
export async function runCognitiveFlow(callChat, input, opts = {}) {
    let currentPhase = 1;
    let context = `Original Problem: ${input}\n`;
    let loopCounter = 0;
    const maxLoops = opts.maxCognitiveLoops || 1;
    let cycleCount = 0;
    const emit = (text) => {
        if (typeof opts.onChunk === 'function') {
            opts.onChunk(text, { kind: 'content' });
        }
    };
    while (currentPhase) {
        const callPhase = async (title, prompt) => {
            emit(`\n\n=========================================\n=== ${title} ===\n=========================================\n\n`);
            const res = await callChat([{ role: 'system', content: prompt }, { role: 'user', content: context }], true, opts.onChunk, { ...opts, think: (opts.depth ?? 0) > 0, autoSystemPrompt: false, samplingProfile: 'reasoning' });
            context += `\n\n[${title}]\n${res.content}`;
            return res.content;
        };
        if (currentPhase === 1) {
            await callPhase('PHASE 1: Problem Intake & Representation', 'You are executing Phase 1 of an elite high-IQ cognitive process.\n' +
                '1. Resist premature formalization (informal first pass to understand the shape of the problem).\n' +
                '2. Identify what is actually unknown (separate given, unknown, and conditions).\n' +
                '3. Build a rich multi-modal representation (diagrams, narratives, analogies).\n' +
                '4. Activate long-term schema memory (pattern-match to known problem classes).\n\n' +
                'Provide your comprehensive Phase 1 breakdown. Do NOT attempt to solve the problem yet.');
            currentPhase = 2;
        }
        else if (currentPhase === 2) {
            await callPhase('PHASE 2: Strategic Planning & Heuristic Selection', 'You are executing Phase 2 of the elite cognitive process.\n' +
                '1. Survey the heuristic toolkit (Analogy, decomposition, generalization, specialization, working backwards).\n' +
                '2. Do divergent search before convergent execution (generate multiple candidate strategies before committing).\n' +
                '3. Identify "good guys" and "bad guys" (narrative framing of which elements help vs. obstruct the solution).\n\n' +
                'Outline your complete strategic plan. Do NOT execute it yet.');
            currentPhase = 3;
        }
        else if (currentPhase === 3) {
            const content = await callPhase('PHASE 3: System 2 Deep Work - Deliberate Execution', 'You are executing Phase 3 of the elite cognitive process.\n' +
                '1. Carry out the plan with error tolerance (execute steps sequentially, accept partial progress).\n' +
                '2. Hierarchical chunking of sub-results (compress solved sub-problems into single units to free working memory).\n' +
                '3. Recursive self-monitoring (metacognition - continuously evaluate if the path is promising).\n\n' +
                'Execute the plan. At the VERY END of your response, you MUST output a JSON block indicating if you reached a complete impasse/stuck state:\n' +
                '{"impasse": true} or {"impasse": false}');
            const parsed = tryParseJsonSafe(content, ImpasseSchema);
            const impasse = parsed ? parsed.impasse : false;
            if (impasse && cycleCount < 3) {
                cycleCount++;
                currentPhase = '3b';
            }
            else {
                currentPhase = 5;
            }
        }
        else if (currentPhase === '3b') {
            await callPhase('PHASE 3b: Problem Transformation & Frame-Shifting', 'You are executing Phase 3b. You hit an impasse and must shift your frame.\n' +
                '1. Transform into an equivalent problem (change coordinates, dualize, generalize, or embed in a larger structure).\n' +
                '2. Question all constraints and assumptions (Which constraints are real? Which were imported unconsciously?).\n' +
                '3. Use analogy across domains (Map the unsolved problem onto a solved one from a different field).\n\n' +
                'Provide your new framework and representation.');
            currentPhase = 4;
        }
        else if (currentPhase === 4) {
            const content = await callPhase('PHASE 4: Incubation - Conscious Disengagement', 'You are executing Phase 4.\n' +
                '1. Deliberately step away (strategic disengagement).\n' +
                '2. Permit mind-wandering (free associate broadly across your knowledge base).\n' +
                '3. Catch illumination.\n\n' +
                'Simulate this associative unconscious processing by generating broad, non-linear connections. At the VERY END, output a JSON block indicating if an actionable insight was achieved:\n' +
                '{"insight": true} or {"insight": false}');
            const parsed = tryParseJsonSafe(content, InsightSchema);
            const insight = parsed ? parsed.insight : true;
            if (!insight && cycleCount < 3) {
                cycleCount++;
                currentPhase = '3b';
            }
            else {
                currentPhase = 3;
            }
        }
        else if (currentPhase === 5) {
            await callPhase('PHASE 5: Verification & Rigorous Checking', 'You are executing Phase 5.\n' +
                '1. Test extreme and degenerate cases (trivial, empty, maximal, adversarial input).\n' +
                '2. Explain the solution to someone else (Feynman technique) to find hand-wavy gaps.\n' +
                '3. Value partial progress; look for generalization (What broader result does this prove?).\n\n' +
                'Verify your results rigorously.');
            currentPhase = 6;
        }
        else if (currentPhase === 6) {
            await callPhase('PHASE 6: Knowledge Integration & Schema Update', 'You are executing Phase 6.\n' +
                '1. Encode the solution as a new template (not just the answer, but the strategy and key moves).\n' +
                '2. Cross-connect to other domains (Where else does this technique apply?).\n\n' +
                'Update your schema and synthesize what was learned.');
            currentPhase = 7;
        }
        else if (currentPhase === 7) {
            const content = await callPhase('PHASE 7: Recursive Application & Problem Generation', 'You are executing Phase 7.\n' +
                '1. Ask: what does this solution make possible? (Use the result as a lemma for the next layer of difficulty).\n' +
                '2. Question the answer\'s assumptions at a higher level (What if the question itself was wrong?).\n\n' +
                'At the VERY END, output a JSON block if you need to loop back with a refined problem to solve, or false if the process is fully complete:\n' +
                '{"loop": true, "problem": "..."} or {"loop": false}');
            const parsed = tryParseJsonSafe(content, LoopSchema);
            const loop = parsed ? parsed.loop : false;
            const nextProblem = parsed?.problem || '';
            if (loop && loopCounter < maxLoops) {
                loopCounter++;
                context += `\n\n--- INITIATING RECURSIVE LOOP ---\nNew Problem Focus: ${nextProblem}\n`;
                currentPhase = 1;
            }
            else {
                currentPhase = null;
            }
        }
        else {
            currentPhase = null;
        }
    }
    return context;
}
