export declare function stripThinkBlocks(t: string | null | undefined): string;
export declare function stripCodeFences(t: string | null | undefined): string;
export type DataType = 'integer' | 'double' | 'boolean' | 'string' | string;
export declare function parseDataType(text: string, dataType: DataType): number | boolean | string;
export declare function extractJSON(text: string): unknown;
export declare const isPlainObject: (v: unknown) => v is Record<string, unknown>;
export interface ChatMessage {
    role: string;
    content: string;
    name?: string;
    images?: string[];
    tool_calls?: unknown[];
}
export declare const isChatMessage: (m: unknown) => m is ChatMessage;
export declare function cloneMessage(m: ChatMessage): ChatMessage;
export declare function messagesToText(input: unknown): string;
export declare function normalizeInputToMessages(input: unknown): ChatMessage[];
export declare function createDefaultSystemPrompt(type: string, depth: number): string;
//# sourceMappingURL=dataTypes.d.ts.map