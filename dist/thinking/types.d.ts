import type { EventEmitter } from 'node:events';
export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface Message {
    role: Role;
    content: string;
    name?: string;
    tool_call_id?: string;
    images?: string[];
    tool_calls?: unknown[];
}
export interface ChatParams {
    model: string;
    messages: Message[];
    stream?: boolean;
    options?: Record<string, unknown>;
    format?: unknown;
    keep_alive?: string | number;
    think?: boolean | string;
    onChunk?: (chunk: string, meta: {
        kind: 'content' | 'thinking';
    }) => void;
    ollamaOutput?: boolean;
}
export interface ChatResult {
    content: string;
    thinking: string;
}
export interface Provider {
    chat(p: ChatParams): Promise<ChatResult>;
}
export type SamplingProfile = 'code' | 'json' | 'creative' | 'reasoning' | 'verify' | 'planning';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'success';
export interface LogEvent {
    level: LogLevel;
    msg: string;
    source?: string;
    ts?: number;
}
export interface StepEvent {
    name: string;
    details?: string;
    ts?: number;
}
export interface TokenEvent {
    content: string;
    kind: 'content' | 'thinking';
    ts?: number;
}
export interface ToolCallEvent {
    tool: string;
    params: Record<string, unknown>;
    ts?: number;
}
export interface ToolResultEvent {
    tool: string;
    output: string;
    ok: boolean;
    ts?: number;
}
export interface DeepthinkOptions {
    model?: string;
    provider?: 'ollama' | 'openai' | 'claude' | 'custom' | 'gemini';
    apiKey?: string;
    host?: string;
    baseUrl?: string;
    samplingProfile?: SamplingProfile;
    think?: boolean;
    maxSteps?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    verbose?: boolean;
    silent?: boolean;
    onLog?: (e: LogEvent) => void;
    onStep?: (e: StepEvent) => void;
    onToken?: (e: TokenEvent) => void;
    [k: string]: unknown;
}
export interface ResearchOptions extends DeepthinkOptions {
    maxDepth?: number;
    breadth?: number;
    maxSources?: number;
    oodBench?: boolean;
}
export interface CodeGenerationOptions extends DeepthinkOptions {
    projectDir?: string;
    entryPoint?: string;
    startCommand?: string;
    runProject?: boolean;
}
export interface Tool {
    name: string;
    description: string;
    params: Record<string, string>;
    run?: (params: Record<string, unknown>) => Promise<unknown>;
}
export interface ToolResult {
    name: string;
    output: string;
    ok: boolean;
}
export type DeepthinkEmitter = Pick<EventEmitter, 'on' | 'off' | 'emit' | 'removeListener' | 'removeAllListeners'>;
//# sourceMappingURL=types.d.ts.map