import type { Message } from './types.js';
type CallChat = (messages: Message[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
    thinking?: string;
}>;
export declare function runThink(callChat: CallChat, inputText: string, depth: number, opts: Record<string, unknown>): Promise<{
    analysis?: string;
}>;
export {};
//# sourceMappingURL=think.d.ts.map