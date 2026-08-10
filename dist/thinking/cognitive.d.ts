type CallChat = (msgs: unknown[], stream: boolean, onChunk: ((chunk: string, meta: {
    kind: 'content' | 'thinking';
}) => void) | undefined, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
interface CognitiveOpts {
    maxCognitiveLoops?: number;
    depth?: number;
    onChunk?: (chunk: string, meta: {
        kind: 'content' | 'thinking';
    }) => void;
    [k: string]: unknown;
}
export declare function runCognitiveFlow(callChat: CallChat, input: string, opts?: CognitiveOpts): Promise<string>;
export {};
//# sourceMappingURL=cognitive.d.ts.map