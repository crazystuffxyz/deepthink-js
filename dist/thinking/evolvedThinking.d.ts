import { BENCH } from './benchmarkSet.js';
type Candidate = {
    id: string;
    parent: string | null;
    operator: string;
    systemPrompt: string;
    n: number;
    names: string[];
    thinkers: string[];
    tone: string;
    outputs?: Record<string, string>;
    score?: {
        aggregate: number;
        detail: unknown[];
        totalWeight: number;
        totalWeighted: number;
    };
    fitness?: number | null;
    [k: string]: unknown;
};
type CallChat = (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
type ChatMessage = {
    role: string;
    content: string;
};
type EvolveOpts = {
    popSize?: number;
    generations?: number;
    bench?: typeof BENCH;
    oodBench?: typeof BENCH | null;
    dataDir?: string;
    runId?: string;
    tournamentK?: number;
    [k: string]: unknown;
};
declare function seedPopulation(n: number, rand?: () => number): Candidate[];
declare function evalCandidate(callChat: CallChat, candidate: Candidate, bench: typeof BENCH, opts: Record<string, unknown>): Promise<{
    outputs: Record<string, string>;
    score: {
        aggregate: number;
        detail: unknown[];
        totalWeight: number;
        totalWeighted: number;
    };
}>;
declare function evolvePrompts(callChat: CallChat, opts?: EvolveOpts): Promise<{
    best: Candidate;
    population: Candidate[];
    runDir: string;
    summary: Record<string, unknown>;
    oodScore: number | null;
}>;
declare function applyEvolvedPrompt(callChat: CallChat, systemPrompt: string, input: unknown, opts?: Record<string, unknown>): Promise<string>;
declare function applyEvolvedPromptWithTrace(callChat: CallChat, systemPrompt: string, input: unknown, opts?: Record<string, unknown>): Promise<{
    think: string;
    answer: string;
    hadThinkBlock: boolean;
}>;
declare function splitTrace(content: string): {
    think: string;
    answer: string;
    hadThinkBlock: boolean;
};
declare function loadBest(runDir: string): Candidate;
declare function scoreOOD(callChat: CallChat, candidate: Candidate, oodBench: typeof BENCH, opts?: Record<string, unknown>): Promise<Record<string, string>>;
export { evolvePrompts, applyEvolvedPrompt, applyEvolvedPromptWithTrace, splitTrace, loadBest, scoreOOD, seedPopulation, evalCandidate };
export type { Candidate };
//# sourceMappingURL=evolvedThinking.d.ts.map