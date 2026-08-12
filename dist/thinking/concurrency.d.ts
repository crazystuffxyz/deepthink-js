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
/** is this error a rate-limit or overload signal? */
export declare function isRateLimitError(err: unknown): boolean;
export declare function isTimeoutError(err: unknown): boolean;
export declare function loadConcurrencyCache(): ConcurrencyCache;
export declare function saveConcurrencyCache(cache: ConcurrencyCache): void;
type State = 'discovering' | 'settling' | 'stable' | 'backoff';
/**
 * AdaptiveConcurrency — exponential-search discovery of the endpoint's
 * concurrency ceiling. Thread-safe enough for one Deepthink instance;
 * call every method from the async loop.
 */
export declare class AdaptiveConcurrency {
    model: string;
    current: number;
    min: number;
    max: number;
    probeCalls: number;
    state: State;
    /** highest level proven clean (0 rate-limits in a full round) */
    lastGood: number;
    /** lowest level that produced a rate limit; Infinity until found */
    firstBad: number;
    private stateBeforeBackoff;
    private cleanCount;
    private backoffUntil;
    private backoffBaseMs;
    private consecutivePressure;
    private lastLatencyAvg;
    private latencies;
    private loggedFirst429;
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
    /** 429 seen — record the bound and binary-search down to the ceiling */
    private hitRateLimit;
    private enterSettling;
    /** point `current` at the midpoint between lastGood and firstBad */
    private reprobeMidpoint;
    /** verdicts during settling need fewer calls than discovery rounds */
    private roundCalls;
    private settle;
    private halve;
    /** short drain pause after hitting the bound — not a punishment, just letting the burst drain */
    private backoffBriefly;
    /** call this after every batch of `n` concurrent calls finishes */
    onBatch(stats: BatchStats): void;
    /** a single call errored outside a batch — same rules apply */
    onError(err: unknown): void;
    /** persist the discovered level so the next process starts warm */
    save(): void;
}
export {};
//# sourceMappingURL=concurrency.d.ts.map