type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
export declare function makePlan(callChat: CallChat, input: unknown, opts?: Record<string, unknown>): Promise<string[]>;
export declare function runStep(callChat: CallChat, step: string, prior: string, inputText: string, opts: Record<string, unknown>): Promise<string>;
export declare function reflect(callChat: CallChat, step: string, output: string, inputText: string, opts: Record<string, unknown>): Promise<string>;
export declare function runPlanAndExecute(callChat: CallChat, input: unknown, opts?: {
    reflect?: boolean;
    [k: string]: unknown;
}): Promise<{
    plan: string[];
    steps: {
        step: string;
        output: string;
    }[];
    answer: string;
}>;
export {};
//# sourceMappingURL=planAndExecute.d.ts.map