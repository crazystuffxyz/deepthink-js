import { compareResults } from './python.js';
export { compareResults };
export declare function fetchPackageDocumentation(callChat: any, packageNames: string[], opts?: any): Promise<Record<string, string>>;
export declare function extractPackageList(callChat: any, task: string, requirementsSpec: any, opts?: any): Promise<{
    dependencies: string[];
    devDependencies: string[];
}>;
export declare function staticAnalysisAgent(_callChat: any, files: Record<string, string>, _task: string, _opts: any): Promise<Array<{
    file: string;
    type: string;
    error?: string;
    ref?: string;
    match?: string;
}>>;
export declare function classifyTaskComplexity(callChat: any, task: string, opts?: any): Promise<{
    level: 'small' | 'medium' | 'large';
    backend: boolean;
    frontend: boolean;
    packages: string[];
    reason: string;
}>;
export declare function pipelinePlan(level: 'small' | 'medium' | 'large'): {
    expand: boolean;
    packages: boolean;
    docs: boolean;
    architecture: boolean;
    pm: boolean;
    ux: boolean;
    security: boolean;
    deployment: boolean;
    maxBugLoops: number;
    maxOracleLoops: number;
    maxFeedbackLoops: number;
};
export declare function generateAndRunProject(callChat: any, task: string, opts?: any): Promise<any>;
//# sourceMappingURL=run.d.ts.map