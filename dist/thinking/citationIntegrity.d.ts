import { z } from 'zod';
declare const TagSchema: z.ZodObject<{
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare function extractSourceTags(text: string): string[];
export declare function checkCitationIntegrity(report: string, refCount: number): {
    cited: Set<number>;
    missing: number[];
    orphans: string[];
};
export declare function checkReferencesSection(report: string, refCount: number): {
    missingRefs: number[];
    ok: boolean;
};
export declare function restoreCitations(callChat: any, report: string, missingIds: number[], claimsByRef: Map<number, string[]>, opts?: any): Promise<string>;
export declare function enforceCitations(callChat: any, report: string, refCount: number, claimsByRef: Map<number, string[]>, opts?: any): Promise<{
    report: string;
    restored: number[];
    orphans: string[];
}>;
export { TagSchema };
//# sourceMappingURL=citationIntegrity.d.ts.map