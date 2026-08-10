import type { ZodType, ZodError } from 'zod';
export declare function extractJsonCandidate(text: string): string | null;
export type ParseResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: ZodError | Error;
    raw: string;
};
export declare function parseJsonSafe<T>(text: string, schema: ZodType<T>): ParseResult<T>;
export declare function tryParseJsonSafe<T>(text: string, schema: ZodType<T>): T | null;
//# sourceMappingURL=json.d.ts.map