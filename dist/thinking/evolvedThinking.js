// thinking/evolvedThinking.ts
import fs from 'node:fs';
import path from 'node:path';
import { BENCH } from './benchmarkSet.js';
import { PATTERNS, samplePatterns, composePrompt, fingerprint, fableMetaPrompt, fableFingerprint } from './thinkingPatterns.js';
import { mutate } from './evolvedMutate.js';
import { scoreAgainstBench } from './evolvedScoring.js';
import { messagesToText } from './dataTypes.js';
let _idSeq = 0;
function nextId(prefix) {
    _idSeq++;
    return `${prefix}-${String(_idSeq).padStart(4, '0')}`;
}
function seedPopulation(n, rand = Math.random) {
    const pop = [];
    for (let i = 0; i < PATTERNS.length && pop.length < n; i++) {
        const p = PATTERNS[i];
        pop.push({
            id: nextId('c'),
            parent: null,
            operator: `seed:${p.name}`,
            systemPrompt: composePrompt([p], { tone: 'neutral' }),
            ...fingerprint(composePrompt([p]))
        });
    }
    const fableVariants = [
        { profile: 'default', intensity: 'medium' },
        { profile: 'default', intensity: 'high' },
        { profile: 'math', intensity: 'medium' },
        { profile: 'code', intensity: 'medium' },
        { profile: 'logic', intensity: 'high' }
    ];
    for (const v of fableVariants) {
        if (pop.length >= n)
            break;
        const sys = fableMetaPrompt(v);
        pop.push({
            id: nextId('c'),
            parent: null,
            operator: `seed:fable[${v.profile}/${v.intensity}]`,
            systemPrompt: sys,
            ...fableFingerprint(sys)
        });
    }
    const handpicked = [
        ['feynman-decompose', 'feynman-elaborate', 'kahneman-wysiati'],
        ['erdos-counterexample', 'knuth-worst-case', 'sagan-baloney-detect'],
        ['ramanujan-intuition', 'ttao-lemma-decompose', 'poincare-incubate'],
        ['curie-isolate-variables', 'mcclintock-anomaly', 'skeptic-stance'],
        ['lamarr-frequency-hop', 'archimedes-analogy', 'lovelace-poetical-science'],
        ['neumann-parallel-drafts', 'kahneman-system2', 'dijkstra-structured-program'],
        ['hard-sf-check', 'knuth-literate', 'dijkstra-proof-by-construction'],
        ['fable-think-format', 'classify-then-route', 'explicit-uncertainty'],
        ['neumann-internal-critic', 'explicit-uncertainty', 'fable-think-format']
    ];
    for (const combo of handpicked) {
        if (pop.length >= n)
            break;
        const ps = combo.map(n => PATTERNS.find(p => p.name === n)).filter(Boolean);
        if (ps.length < 2)
            continue;
        const sys = composePrompt(ps, { tone: 'didactic' });
        pop.push({
            id: nextId('c'),
            parent: null,
            operator: `seed:curated[${combo.join('+')}]`,
            systemPrompt: sys,
            ...fingerprint(sys)
        });
    }
    while (pop.length < n) {
        const ps = samplePatterns(2 + Math.floor(rand() * 3), rand);
        const sys = composePrompt(ps, { tone: rand() < 0.5 ? 'neutral' : 'didactic' });
        pop.push({
            id: nextId('c'),
            parent: null,
            operator: `seed:random`,
            systemPrompt: sys,
            ...fingerprint(sys)
        });
    }
    return pop.slice(0, n);
}
async function evalCandidate(callChat, candidate, bench, opts) {
    const outputs = {};
    for (const item of bench) {
        const msgs = [
            { role: 'system', content: candidate.systemPrompt },
            { role: 'user', content: item.prompt }
        ];
        try {
            const t0 = Date.now();
            const r = await callChat(msgs, false, null, {
                ...opts,
                think: false,
                autoSystemPrompt: false,
                samplingProfile: item.kind === 'code' ? 'code' : 'reasoning',
                temperature: item.kind === 'code' ? 0.1 : 0.4
            });
            const dt = Date.now() - t0;
            outputs[item.id] = r.content || '';
            if (process.stdout?.write)
                process.stdout.write(`  [eval] ${candidate.id} ${item.id} (${item.kind}) ${dt}ms len=${outputs[item.id].length}\n`);
        }
        catch (e) {
            outputs[item.id] = `__ERROR__: ${e.message}`;
            if (process.stdout?.write)
                process.stdout.write(`  [eval] ${candidate.id} ${item.id} ERR: ${e.message}\n`);
        }
    }
    const score = await scoreAgainstBench(callChat, outputs, bench, opts);
    return { outputs, score };
}
async function oneGeneration(callChat, population, bench, opts, log) {
    const evaluated = [];
    for (const c of population) {
        if (c.fitness != null) {
            evaluated.push(c);
            continue;
        }
        const r = await evalCandidate(callChat, c, bench, opts);
        c.outputs = r.outputs;
        c.score = r.score;
        c.fitness = r.score.aggregate;
        evaluated.push(c);
    }
    evaluated.sort((a, b) => b.fitness - a.fitness);
    const leaderboard = evaluated.slice(0, 5).map(c => ({ id: c.id, score: c.fitness, systemPrompt: c.systemPrompt }));
    const children = [];
    const popSize = population.length;
    for (let i = 0; i < popSize; i++) {
        const parent = tournamentSelect(evaluated, opts.tournamentK || 3);
        const kids = await mutate(parent, { callChat, opts, leaderboard });
        for (const k of kids) {
            if (!k.id)
                k.id = nextId('c');
            k.fitness = null;
            children.push(k);
        }
    }
    for (const c of children) {
        const r = await evalCandidate(callChat, c, bench, opts);
        c.outputs = r.outputs;
        c.score = r.score;
        c.fitness = r.score.aggregate;
    }
    const all = [...evaluated, ...children];
    all.sort((a, b) => b.fitness - a.fitness);
    const next = all.slice(0, popSize);
    const best = next[0];
    const median = next[Math.floor(next.length / 2)].fitness;
    const summary = {
        gen: (log.gen || 0) + 1,
        bestId: best.id,
        bestFitness: best.fitness,
        median,
        population: next.map(c => ({ id: c.id, fitness: c.fitness, parent: c.parent, operator: c.operator })),
        leaderboard: leaderboard.map(l => ({ id: l.id, score: l.score }))
    };
    log.gen = summary.gen;
    log.history.push(summary);
    return next;
}
function tournamentSelect(population, k = 3) {
    const tour = [];
    for (let i = 0; i < k; i++) {
        tour.push(population[Math.floor(Math.random() * population.length)]);
    }
    return tour.reduce((best, c) => c.fitness > best.fitness ? c : best);
}
async function evolvePrompts(callChat, opts = {}) {
    const popSize = opts.popSize || 10;
    const generations = opts.generations || 8;
    const bench = opts.bench || BENCH;
    const oodBench = opts.oodBench || null;
    const dataDir = opts.dataDir || path.join(process.cwd(), 'data', 'evolved');
    fs.mkdirSync(dataDir, { recursive: true });
    const runId = opts.runId || new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(dataDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const log = { gen: 0, history: [] };
    let population = seedPopulation(popSize);
    fs.writeFileSync(path.join(runDir, 'population-gen-000.json'), JSON.stringify(population, null, 2), 'utf-8');
    for (let g = 0; g < generations; g++) {
        population = await oneGeneration(callChat, population, bench, opts, log);
        fs.writeFileSync(path.join(runDir, `population-gen-${String(log.gen).padStart(3, '0')}.json`), JSON.stringify(population.map(c => ({
            id: c.id, parent: c.parent, operator: c.operator,
            systemPrompt: c.systemPrompt, fitness: c.fitness, score: c.score,
            fingerprint: { n: c.n, names: c.names, thinkers: c.thinkers, tone: c.tone }
        })), null, 2), 'utf-8');
        const best = population[0];
        const median = population[Math.floor(population.length / 2)].fitness;
        if (process.stdout?.write)
            process.stdout.write(`[evolve] gen ${log.gen}  best=${best.fitness.toFixed(3)} (${best.id})  median=${median.toFixed(3)}  op=${best.operator || 'seed'}\n`);
    }
    let best = population[0];
    let oodScore = null;
    if (oodBench && oodBench.length) {
        try {
            const r = await evalCandidate(callChat, best, oodBench, opts);
            oodScore = r.score.aggregate;
            const gap = best.fitness - oodScore;
            if (process.stdout?.write)
                process.stdout.write(`[evolve] OOD fitness: ${oodScore.toFixed(3)}  gap: ${gap.toFixed(3)}${gap > 0.20 ? '  overfit' : '  generalizes'}\n`);
            fs.writeFileSync(path.join(runDir, 'ood-score.json'), JSON.stringify({ idFitness: best.fitness, oodFitness: oodScore, gap, detail: r.score.detail }, null, 2), 'utf-8');
        }
        catch (e) {
            if (process.stdout?.write)
                process.stdout.write(`[evolve] OOD probe failed: ${e.message}\n`);
        }
    }
    const finalSummary = {
        runId,
        popSize,
        generations,
        bench: bench.map(b => b.id),
        oodBench: oodBench ? oodBench.map(b => b.id) : null,
        best,
        bestPerGen: log.history.map(h => ({ gen: h.gen, bestId: h.bestId, bestFitness: h.bestFitness, median: h.median })),
        operatorUsage: countOps(log.history.flatMap(h => h.population)),
        oodScore
    };
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(finalSummary, null, 2), 'utf-8');
    return { best, population, runDir, summary: finalSummary, oodScore };
}
function countOps(pop) {
    const c = {};
    for (const x of pop) {
        const op = x.operator || 'unknown';
        c[op] = (c[op] || 0) + 1;
    }
    return c;
}
async function applyEvolvedPrompt(callChat, systemPrompt, input, opts = {}) {
    const msgs = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: messagesToText(input) }
    ];
    const r = await callChat(msgs, false, null, {
        ...opts,
        think: false,
        autoSystemPrompt: false,
        samplingProfile: opts.samplingProfile || 'reasoning'
    });
    return r.content || '';
}
async function applyEvolvedPromptWithTrace(callChat, systemPrompt, input, opts = {}) {
    const content = await applyEvolvedPrompt(callChat, systemPrompt, input, opts);
    return splitTrace(content);
}
function splitTrace(content) {
    const text = String(content || '');
    const m = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    if (!m)
        return { think: '', answer: text.trim(), hadThinkBlock: false };
    const think = m[1].trim();
    const answer = text.replace(m[0], '').trim();
    return { think, answer, hadThinkBlock: true };
}
function loadBest(runDir) {
    const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf-8'));
    return summary.best;
}
async function scoreOOD(callChat, candidate, oodBench, opts = {}) {
    const { outputs } = await evalCandidate(callChat, candidate, oodBench, opts);
    return outputs;
}
export { evolvePrompts, applyEvolvedPrompt, applyEvolvedPromptWithTrace, splitTrace, loadBest, scoreOOD, seedPopulation, evalCandidate };
