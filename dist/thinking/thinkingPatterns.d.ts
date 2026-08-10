export interface ThinkingPattern {
    name: string;
    thinker: string;
    move: string;
    when: string;
    template: string;
    exemplar: string;
}
export declare const PATTERNS: ThinkingPattern[];
export declare const PATTERN_BY_NAME: Record<string, ThinkingPattern>;
export declare function samplePatterns(n: number, rand?: () => number): ThinkingPattern[];
export interface ComposeOpts {
    tone?: 'didactic' | 'socratic' | 'terse' | 'neutral';
}
export declare function composePrompt(patterns: ThinkingPattern[], opts?: ComposeOpts): string;
export interface Fingerprint {
    n: number;
    thinkers: string[];
    names: string[];
    tone: string;
}
export declare function fingerprint(prompt: string): Fingerprint;
export declare function patternsIn(prompt: string): ThinkingPattern[];
export interface FableOpts {
    profile?: 'math' | 'code' | 'logic' | 'planning' | 'puzzle' | 'default';
    intensity?: 'low' | 'medium' | 'high';
}
export declare function fableMetaPrompt(opts?: FableOpts): string;
export interface FableFingerprint extends Fingerprint {
    hasFable: boolean;
    hasClassify: boolean;
}
export declare function fableFingerprint(prompt: string): FableFingerprint;
//# sourceMappingURL=thinkingPatterns.d.ts.map