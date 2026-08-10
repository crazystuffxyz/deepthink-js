export interface BenchItem {
    id: string;
    kind: string;
    prompt: string;
    reference?: unknown;
    numericTolerance?: number;
    weight?: number;
    rubric?: Record<string, number>;
}
export declare const BENCH: BenchItem[];
export declare function getBenchById(id: string): BenchItem | undefined;
export declare function numericScore(value: number, ref: number, tol: number): number;
export declare function includesAnyCaseInsensitive(text: string, words: string[]): boolean;
export declare const OOD_BENCH: BenchItem[];
//# sourceMappingURL=benchmarkSet.d.ts.map