type Tool = {
    name: string;
    description: string;
    params: Record<string, string>;
    run?: (params: Record<string, unknown>) => Promise<unknown>;
};
type ToolCall = {
    tool: string;
    params?: Record<string, unknown>;
    code?: string;
};
type ChatResult = {
    content: string;
    thinking?: string;
};
type CallChat = (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<ChatResult>;
type ChatMessage = {
    role: string;
    content: string;
};
declare const DEFAULT_TOOLS: Tool[];
declare function describeTools(tools: Tool[]): string;
declare function parseToolCall(text: string): ToolCall | null;
type TraceStep = {
    step: number;
    call: ToolCall;
    output?: unknown;
};
declare function toolLoop(callChat: CallChat, input: unknown, opts?: {
    tools?: Tool[] | boolean;
    maxSteps?: number;
    [k: string]: unknown;
}): Promise<{
    answer: string;
    steps: TraceStep[];
    finished: boolean;
}>;
export { toolLoop, parseToolCall, describeTools, DEFAULT_TOOLS };
export type { Tool, ToolCall, TraceStep };
//# sourceMappingURL=toolUse.d.ts.map