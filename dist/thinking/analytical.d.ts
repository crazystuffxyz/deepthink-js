import { z } from 'zod';
type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
type Generate = (input: unknown, opts: Record<string, unknown>) => Promise<unknown>;
type Limiter = {
    run<T>(fn: () => Promise<T>): Promise<T>;
};
type Context = {
    callChat: CallChat;
    generate: Generate;
    limiter: Limiter;
};
type OnChunk = ((chunk: string) => void) | null;
declare const DecompSchema: z.ZodUnion<readonly [z.ZodObject<{
    decomposable: z.ZodLiteral<true>;
    subProblems: z.ZodArray<z.ZodString>;
    mergeOperation: z.ZodOptional<z.ZodEnum<{
        custom: "custom";
        add: "add";
        multiply: "multiply";
    }>>;
    sharedConstraints: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    decomposable: z.ZodLiteral<false>;
    subProblems: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>]>;
declare function analyzeDecomposability(callChat: CallChat, inputText: string, analyticalDepth: number, opts: Record<string, unknown>): Promise<z.infer<typeof DecompSchema>>;
declare function mergeSubResults(callChat: CallChat, originalInput: unknown, subProblems: string[], subResults: string[], decomp: {
    mergeOperation?: 'add' | 'multiply' | 'custom';
    sharedConstraints?: string[];
}, opts: Record<string, unknown>, log?: (level: 'info' | 'warn', msg: string) => void): Promise<string>;
export declare function analyzeAndSolve(ctx: Context, input: unknown, type: string, depth: number, checks: unknown, onChunk: OnChunk, opts: Record<string, unknown>, analyticalDepth?: number): Promise<unknown>;
export { analyzeDecomposability, mergeSubResults };
//# sourceMappingURL=analytical.d.ts.map