type Candidate = {
    id: string;
    parent: string | null;
    operator: string;
    systemPrompt: string;
    n: number;
    names: string[];
    thinkers: string[];
    tone: string;
    [k: string]: unknown;
};
type Ctx = {
    callChat: (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
        content: string;
    }>;
    opts: Record<string, unknown>;
    leaderboard?: {
        score: number;
        systemPrompt: string;
    }[];
};
type Op = {
    name: string;
    description: string;
    apply: (parent: Candidate, ctx: Ctx) => Promise<Candidate[]>;
};
type ChatMessage = {
    role: string;
    content: string;
};
declare const OPERATORS: Op[];
declare function mutate(parent: Candidate, ctx: Ctx, rand?: () => number): Promise<Candidate[]>;
export { OPERATORS, mutate };
export type { Candidate, Ctx, Op };
//# sourceMappingURL=evolvedMutate.d.ts.map