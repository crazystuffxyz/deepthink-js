export declare const DEFAULT_PATH: string;
export interface Store {
    path: string;
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    set(key: string, val: unknown): void;
    add(key: string, val: Record<string, unknown>): void;
    push(key: string, val: unknown): void;
    list<T = unknown>(key: string): T[];
    flush(): void;
    stats(): {
        keys: number;
        dirty: boolean;
        file: string;
    };
}
export declare function makeStore(file?: string): Store;
export declare function makeEphemeralStore(): Store;
//# sourceMappingURL=memory.d.ts.map