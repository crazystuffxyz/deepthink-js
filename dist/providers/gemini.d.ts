export declare function isGeminiWebAvailable(cookieMap: Record<string, string>): boolean;
export declare function getActiveGoogleEmail(cookieMap: Record<string, string>): Promise<string | null>;
export type QueryOptions = {
    model?: string;
    youtubeUrl?: string;
    files?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
};
export declare function queryWithCookies(prompt: string, cookieMap: Record<string, string>, options?: QueryOptions): Promise<string>;
export declare const MODELS: string[];
//# sourceMappingURL=gemini.d.ts.map