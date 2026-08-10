export declare function approxTokens(text: string): number;
export declare function totalTokens(messages: {
    content: string;
}[]): number;
type CallChat = (messages: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
export declare function compress(callChat: CallChat, messages: {
    role: string;
    content: string;
}[], opts?: {
    maxTokens?: number;
    think?: boolean;
    autoSystemPrompt?: boolean;
    samplingProfile?: string;
    [k: string]: unknown;
}): Promise<{
    role: string;
    content: string;
}[]>;
export declare function truncateMiddle(messages: {
    role: string;
    content: string;
}[], keepFirst?: number, keepLast?: number): {
    role: string;
    content: string;
}[];
export {};
//# sourceMappingURL=smartCompression.d.ts.map