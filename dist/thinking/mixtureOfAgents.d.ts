interface Caller {
    name: string;
    callChat: (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
        content: string;
    }>;
}
type CallChat = Caller['callChat'];
interface RunOpts {
    autoSystemPrompt?: boolean;
    think?: boolean;
    samplingProfile?: string;
    [k: string]: unknown;
}
declare function fanOut(callers: Caller[], input: unknown, opts?: RunOpts): Promise<{
    name: string;
    content?: string;
    error?: string;
}[]>;
declare function judge(callChat: CallChat, input: unknown, candidates: {
    name: string;
    content?: string;
}[], opts?: RunOpts): Promise<string>;
export declare function runMoA(callers: Caller[], judgeCaller: CallChat, input: unknown, opts?: RunOpts): Promise<{
    answer: string;
    candidates: {
        name: string;
        content?: string;
        error?: string;
    }[];
}>;
export { fanOut, judge };
//# sourceMappingURL=mixtureOfAgents.d.ts.map