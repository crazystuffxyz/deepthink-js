export declare function bucket(type: string | undefined): string;
interface Stats {
    attempts: number;
    wins: number;
    history: number[];
}
export interface Calibrator {
    record(type: string, passed: boolean): Stats;
    rate(type: string): number;
    confidenceFor(type: string): number;
    summary(): Record<string, {
        attempts: number;
        wins: number;
        rate: number;
        confidence: number;
    }>;
    snapshot(): Record<string, Stats>;
}
export declare function makeCalibrator(initial?: Record<string, Partial<Stats>>): Calibrator;
export {};
//# sourceMappingURL=confidence.d.ts.map