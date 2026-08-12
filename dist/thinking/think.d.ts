import type { Message } from './types.js';
type CallChat = (messages: Message[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
    thinking?: string;
}>;
export declare function runThink(callChat: CallChat, inputText: string, depth: number, opts: Record<string, unknown>): Promise<{
    analysis?: string;
    answers?: Array<{
        tag: string;
        answer: string | null;
        conf?: number;
    }>;
    consensus?: string | null;
    agreement?: number;
    consensusText?: string | null;
}>;
export {};
//# sourceMappingURL=think.d.ts.map