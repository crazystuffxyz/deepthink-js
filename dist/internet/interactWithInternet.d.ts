type SearchResult = {
    link: string;
    title?: string;
    snippet?: string;
    cite?: string;
};
export declare function getFetchResults(url: string): Promise<string>;
export declare function getSearchResults(query: string, opts?: {
    useOllamaSearch?: boolean;
    [k: string]: unknown;
}): Promise<SearchResult[] | null>;
export {};
//# sourceMappingURL=interactWithInternet.d.ts.map