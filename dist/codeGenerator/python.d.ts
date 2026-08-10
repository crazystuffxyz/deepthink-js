import { PYTHON_BIN } from './sandbox.js';
export { PYTHON_BIN };
export declare function compareResults(a: string | number | null, b: string | number | null): boolean;
export declare function mathematicianAgent(callChat: any, task: string, inputText: string, opts: any): Promise<string>;
export declare function engineerAgent(callChat: any, mathSpec: string, task: string, inputText: string, language: string, opts: any): Promise<string>;
export declare function fixCodeRuntime(callChat: any, task: string, code: string, language: string, error: string): Promise<string>;
export declare function runMCTSApproaches(callChat: any, task: string, inputText: string, opts?: any): Promise<{
    result: string;
    count: number;
    total: number;
    confidence: string;
    sandboxValidated: boolean;
} | null>;
export declare function reconcileResults(jsResult: string, pyResult: string | null): Promise<string>;
export declare function generateAndRunCode(callChat: any, task: string, inputText: string, opts?: any): Promise<{
    result: string;
    jsResult: string | null;
    pyResult: string | null;
    sandboxValidated: boolean;
    mctsConsensus?: any;
}>;
//# sourceMappingURL=python.d.ts.map