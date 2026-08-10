type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
declare function sampleOnce(callChat: CallChat, input: unknown, opts: {
    samplingProfile?: string;
    think?: boolean;
    autoSystemPrompt?: boolean;
    [k: string]: unknown;
}): Promise<string>;
export declare function vote(samples: string[]): string;
export declare function selfConsistency(callChat: CallChat, input: unknown, opts?: {
    samples?: number;
    samplingProfile?: string;
    [k: string]: unknown;
}): Promise<{
    answer: string;
    samples: string[];
    count: number;
    votes: number;
}>;
export { sampleOnce };
//# sourceMappingURL=consistency.d.ts.map