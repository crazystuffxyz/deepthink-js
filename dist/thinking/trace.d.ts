export type TraceMode = 'off' | 'flat' | 'hierarchical' | 'calls';
export type TraceStatus = 'ok' | 'error' | 'timeout' | 'aborted';
export interface TraceEvent {
    callId: number;
    parentCallId: number | null;
    depth: number;
    ts: number;
    model: string;
    phase: string;
    prompt: string;
    response: string;
    latencyMs: number;
    promptTokens: number | null;
    responseTokens: number | null;
    status: TraceStatus;
    error: string | null;
    concurrency: number;
}
/**
 * TraceStore — append-only record of LLM calls. Scopes model the
 * pipeline hierarchy (generate -> think -> final), so parallel calls
 * inside one scope share a parent and keep deterministic ids.
 */
export declare class TraceStore {
    events: TraceEvent[];
    mode: TraceMode;
    maxEvents: number;
    dropped: number;
    private nextCallId;
    private nextScopeId;
    private scopes;
    private startedAt;
    constructor(mode?: TraceMode, maxEvents?: number);
    get depth(): number;
    get parentCallId(): number | null;
    /** push a pipeline scope; returns a handle for pop() */
    pushScope(phase: string, depthOffset?: number): number;
    popScope(): void;
    markStart(): void;
    begin(opts: {
        phase: string;
        model: string;
        prompt: string;
        concurrency: number;
        parentCallId?: number | null;
        depth?: number;
    }): number;
    end(callId: number, patch: Partial<TraceEvent>): void;
    get size(): number;
    get durationMs(): number;
    /** structured export — machine readable, independent of the XML formatters */
    toJSON(): TraceEvent[];
    /** one big <thinking> block containing the entire internal transcript */
    formatFlat(): string;
    /** nested depth-labelled blocks per scope */
    formatHierarchical(): string;
    /** one block per LLM call, tagged with its id */
    formatCalls(): string;
    /** format according to the configured mode */
    format(): string;
    /** human-readable summary line for pipeline end */
    summarize(): string;
}
//# sourceMappingURL=trace.d.ts.map