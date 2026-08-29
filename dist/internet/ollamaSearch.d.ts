export type WebSearchResult = {
    title: string;
    link: string;
    snippet: string;
    cite: string;
};
export declare function getOllamaSearchResults(query: string, maxResults?: number): Promise<WebSearchResult[]>;
export declare function reformulateQuery(q: string): string | null;
//# sourceMappingURL=ollamaSearch.d.ts.map