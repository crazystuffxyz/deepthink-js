import { EventEmitter } from 'node:events';
import PQueue from 'p-queue';
import { TraceStore } from './trace.js';
import { AdaptiveConcurrency } from './concurrency.js';
declare const SAMPLING: {
    creative: {
        temperature: number;
        top_p: number;
        top_k: number;
    };
    reasoning: {
        temperature: number;
        top_p: number;
        top_k: number;
    };
    json: {
        temperature: number;
        top_p: number;
        top_k: number;
    };
    verify: {
        temperature: number;
        top_p: number;
        top_k: number;
    };
    code: {
        temperature: number;
        top_p: number;
        top_k: number;
    };
};
type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogEvent = {
    level: LogLevel;
    msg: string;
    source: string;
    ts: number;
};
type Check = {
    correct: boolean;
    feedback: string | null;
};
type CheckResult = Check;
type ChatMessage = {
    role: string;
    content: string;
    images?: string[];
    name?: string;
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
    onChunk?: ((chunk: string, meta: {
        kind: 'content' | 'thinking';
    }) => void) | null;
    ollamaOutput?: boolean;
};
type ChatResult = {
    content: string;
    thinking?: string;
    promptTokens?: number | null;
    responseTokens?: number | null;
    latencyMs?: number | null;
};
type ProviderClient = {
    chat: (p: ChatParams) => Promise<ChatResult>;
};
type DeepthinkOptions = {
    model?: string;
    type?: string;
    depth?: number;
    checks?: number;
    checkStyle?: 'full' | 'blind';
    onChunk?: ((chunk: string, meta: {
        kind: 'content' | 'thinking';
    }) => void) | null;
    mixtureModels?: Array<string | {
        name: string;
        callChat?: (...a: unknown[]) => Promise<unknown>;
    }>;
    mixtureJudge?: (...a: unknown[]) => Promise<unknown>;
    evolve?: boolean;
    evolveOnly?: boolean;
    evolvePop?: number;
    evolveGenerations?: number;
    evolveRunId?: string;
    evolvedApply?: string;
    tools?: boolean | object;
    planExecute?: boolean;
    debate?: boolean;
    selfConsistency?: boolean;
    selfConsistencySamples?: number;
    reflexion?: boolean;
    calibrate?: boolean;
    _calibration?: Record<string, {
        wins: number;
        losses: number;
    }>;
    _groundTruth?: unknown;
    analytical?: boolean;
    cognitiveFlow?: boolean;
    _skipAnalytical?: boolean;
    _skipCognitiveFlow?: boolean;
    systemPrompt?: string;
    autoSystemPrompt?: boolean;
    images?: string[];
    enableCode?: boolean;
    samplingProfile?: keyof typeof SAMPLING;
    options?: Record<string, unknown>;
    format?: string | object;
    think?: boolean | string;
    keep_alive?: string;
    max_tokens?: number;
    ollamaOutput?: boolean;
    autoChoose?: boolean;
    forceStream?: boolean;
    _globalBudget?: {
        llmCalls: number;
        maxLLMCalls: number;
    };
    _brain?: Brain;
    humanBrain?: boolean;
    maxCheckIterations?: number;
    monitorWindowSize?: number;
    _lastResultFailed?: string;
    _compressMessages?: ChatMessage[];
    _truncatableMessages?: ChatMessage[];
    verbose?: boolean;
    provider?: string;
    _trace?: TraceStore;
    _phase?: string;
    _depth?: number;
    _parentCallId?: number | null;
    [k: string]: unknown;
};
declare class Brain {
    workingMemory: Array<{
        _failCount?: number;
    } & Record<string, unknown>>;
    semantic: string[];
    capacity: number;
    constructor(opts?: {
        capacity?: number;
    });
    isOverCapacity(): boolean;
    evict(): Array<Record<string, unknown>>;
    appendToSemantic(s: string): void;
    add(k: string, v: string, p?: number): void;
    getContextBlock(): string;
}
declare class Async {
    private chain;
    run<T>(fn: () => Promise<T>): Promise<T>;
}
export declare class Deepthink extends EventEmitter {
    model: string;
    auditModel: string;
    apiKeys: string[];
    currentKeyIndex: number;
    clientOptions: Record<string, unknown>;
    limiter: PQueue;
    concurrencyScaler: AdaptiveConcurrency | null;
    traceMode: string;
    _keyFailures: Map<string, {
        count: number;
        quarantineUntil: number;
    }>;
    _keyMutex: Async;
    _globalLogBridge: (e: LogEvent) => void;
    _lastTrace: TraceStore | null;
    _activeCalls: number;
    _batch: {
        calls: number;
        errors: number;
        rateLimited: number;
        timeouts: number;
        latencies: number[];
    };
    constructor(model?: string, apiKeys?: string[], clientOptions?: Record<string, unknown>, concurrency?: number, auditModel?: string | null, extra?: {
        adaptiveConcurrency?: boolean;
        traceMode?: string;
        maxConcurrency?: number;
    });
    /**
       * Cleans up global event listeners to prevent memory leaks.
       * Call this when you are finished with a Deepthink instance in long-running applications.
       */
    destroy(): void;
    _log(level: LogLevel, source: string, msg: string): void;
    _syncConcurrency(): void;
    /** accumulate per-call stats (attempts that hit the wire) */
    _recordBatchCall(ok: boolean, rateLimited: boolean, timedOut: boolean, latencyMs: number): void;
    /** when all in-flight work drains, hand the batch to the scaler so it
     *  can double/hold/halve. */
    _maybeFlushBatch(): void;
    getNextApiKey(): Promise<string | null>;
    _markKeyFailure(key: string | null): void;
    _markKeySuccess(key: string | null): void;
    buildClient(key: string | null): ProviderClient;
    normalizeMessages(input: unknown, opts?: DeepthinkOptions): ChatMessage[];
    callChat(messages: ChatMessage[], stream?: boolean, onChunk?: ((chunk: string, meta: {
        kind: 'content' | 'thinking';
    }) => void) | null, opts?: DeepthinkOptions): Promise<ChatResult>;
    detectComputeNeeds(input: unknown, opts?: DeepthinkOptions): Promise<{
        mode: 'none' | 'single' | 'parallel';
        task?: string;
        tasks?: string[];
    }>;
    runChecks(input: unknown, response: string, checksCount: number, opts?: DeepthinkOptions, groundTruth?: {
        value: unknown;
        sandboxValidated?: boolean;
    } | null, sandboxPrefix?: ChatMessage[]): Promise<CheckResult[]>;
    consolidateBrainMemory(brain: Brain, opts?: DeepthinkOptions): Promise<void>;
    generate(input: unknown, opts?: DeepthinkOptions): Promise<unknown>;
    private _generateInner;
}
export default Deepthink;
//# sourceMappingURL=deepthink.d.ts.map