export declare function sanitizeResultLink(link: string): string;
export declare function getMullvadLetaResults(query: string, desiredResultCount?: number, maxPagesToFetch?: number, perPageRetries?: number, engine?: string): Promise<Array<{
    title: string;
    link: string;
    snippet: string;
    cite: string;
}>>;
//# sourceMappingURL=mullvadLetaClient.d.ts.map