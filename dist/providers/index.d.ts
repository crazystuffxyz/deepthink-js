type ChatMessage = {
    role: string;
    content: string;
    images?: string[];
};
type ChatResult = {
    content: string;
    thinking: string;
    promptTokens?: number | null;
    responseTokens?: number | null;
    latencyMs?: number | null;
};
type StreamMeta = {
    kind: 'content' | 'thinking';
};
type ChatParams = {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    options?: Record<string, unknown>;
    think?: boolean | string;
    format?: string | object;
    keep_alive?: string;
    max_tokens?: number;
    onChunk?: ((chunk: string, meta: StreamMeta) => void) | null;
    ollamaOutput?: boolean;
};
type ProviderClient = {
    chat: (p: ChatParams) => Promise<ChatResult>;
};
type ProviderOpts = {
    provider?: string;
    host?: string;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    anthropicVersion?: string;
    [k: string]: unknown;
};
declare function buildOllamaClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildOpenAICompatClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildCustomClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildClaudeClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildGeminiClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildGeminiWebClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildPerplexityClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildGrokClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildLMStudioClient(opts: ProviderOpts, apiKey: string | null): ProviderClient;
declare function buildProviderClient(opts?: ProviderOpts, apiKey?: string | null): ProviderClient;
export { buildProviderClient, buildCustomClient, buildOllamaClient, buildOpenAICompatClient, buildClaudeClient, buildGeminiClient, buildGeminiWebClient, buildPerplexityClient, buildGrokClient, buildLMStudioClient };
export type { ProviderClient, ChatParams, ChatMessage, ChatResult, ProviderOpts };
//# sourceMappingURL=index.d.ts.map