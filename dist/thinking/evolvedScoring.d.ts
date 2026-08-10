import { numericScore } from './benchmarkSet.js';
type BenchItem = {
    id: string;
    kind: string;
    prompt: string;
    reference?: unknown;
    numericTolerance?: number;
    weight?: number;
    rubric?: Record<string, number>;
};
type CallChat = (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
type ChatMessage = {
    role: string;
    content: string;
};
declare function extractNumber(text: string): number;
declare function extractProbability(text: string, ref: number): number;
declare function extractAllNumbers(text: string): number[];
declare function multiNumberScore(text: string, reference: Record<string, number> | number[], tol: number): {
    score: number;
    matched: number;
    total: number;
};
declare function extractTime(text: string): {
    hour: number;
    minute: number;
} | null;
declare function runPythonIfPresent(text: string): Promise<unknown>;
declare function runCodeTests(text: string, item: BenchItem): Promise<{
    ran: boolean;
    passed: number;
    total: number;
    fnName?: string;
    error?: string;
}>;
declare function llmJudge(callChat: CallChat, text: string, item: BenchItem, opts: Record<string, unknown>): Promise<{
    score: number;
    breakdown: Record<string, number> | null;
    reason?: string;
    raw?: string;
    error?: string;
}>;
type ScoreOneOut = {
    itemId: string;
    kind: string;
    components: Record<string, unknown>;
    score: number;
    weighted: number;
    extracted?: unknown;
    thinkBonus?: number;
    timeOk?: number;
    distOk?: number;
};
declare function scoreOne(callChat: CallChat, output: string, item: BenchItem, opts?: Record<string, unknown>): Promise<ScoreOneOut>;
declare function scoreAgainstBench(callChat: CallChat, outputs: Record<string, string>, bench: BenchItem[], opts?: Record<string, unknown>): Promise<{
    aggregate: number;
    detail: ScoreOneOut[];
    totalWeight: number;
    totalWeighted: number;
}>;
export { scoreOne, scoreAgainstBench, extractNumber, extractProbability, extractAllNumbers, multiNumberScore, extractTime, runPythonIfPresent, runCodeTests, llmJudge, numericScore };
export type { BenchItem, ScoreOneOut };
//# sourceMappingURL=evolvedScoring.d.ts.map