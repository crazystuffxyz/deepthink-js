export interface BatchStats {
    calls: number;
    errors: number;
    rateLimited: number;
    timeouts: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
}
export interface ConcurrencyCache {
    [model: string]: {
        level: number;
        when: number;
    };
}
/** is this error a rate-limit or overload signal we must back off from? */
export declare function isRateLimitError(err: unknown): boolean;
export declare function isTimeoutError(err: unknown): boolean;
export declare function loadConcurrencyCache(): ConcurrencyCache;
export declare function saveConcurrencyCache(cache: ConcurrencyCache): void;
/**
 * AdaptiveConcurrency — doubles after clean probes, halves on
 * pressure, backs off with jitter. Thread-safe enough for one
 * Deepthink instance; call every method from the async loop.
 */
export declare class AdaptiveConcurrency {
    model: string;
    current: number;
    min: number;
    max: number;
    probeCalls: number;
    state: 'probing' | 'stable' | 'backoff';
    private cleanCount;
    private backoffUntil;
    private backoffBaseMs;
    private consecutivePressure;
    private lastLatencyAvg;
    private latencies;
    onEvent: (msg: string) => void;
    constructor(opts: {
        model: string;
        start?: number;
        min?: number;
        max?: number;
        probeCalls?: number;
        backoffBaseMs?: number;
        onEvent?: (msg: string) => void;
    });
    get level(): number;
    /** can we dispatch a call right now? (false during backoff) */
    canDispatch(): boolean;
    waitForDispatch(): Promise<void>;
    private double;
    private halve;
    /** call this after every batch of `n` concurrent calls finishes */
    onBatch(stats: BatchStats): void;
    /** a single call errored outside a batch — same rules apply */
    onError(err: unknown): void;
    /** persist the discovered level so the next process starts warm */
    save(): void;
}
//# sourceMappingURL=concurrency.d.ts.map