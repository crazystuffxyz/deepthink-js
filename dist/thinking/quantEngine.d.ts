export type QuantModel = {
    ok: boolean;
    price: number | null;
    priceSource: string;
    eps: number | null;
    growth: number | null;
    beta: number | null;
    rf: number;
    erp: number;
    costOfEquity: number | null;
    sigma: number | null;
    intrinsicValue: number | null;
    expectedReturn: number | null;
    expectedLogReturn: number | null;
    expectedPrice: number | null;
    sharpe: number | null;
    var95_1d: number | null;
    var99_1d: number | null;
    var95_1y: number | null;
    upside: number | null;
    section: string;
    inputs: string[];
};
export declare function runQuantModel(claims: string[], rawTexts?: string[]): QuantModel;
//# sourceMappingURL=quantEngine.d.ts.map