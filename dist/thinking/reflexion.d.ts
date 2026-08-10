export declare function keyFor(text: string): string;
export declare function findRelevant<T extends {
    key?: string;
}>(lessons: T[], input: string, k?: number, threshold?: number): T[];
type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
export declare function writeLesson(callChat: CallChat, input: unknown, failure: string, opts: Record<string, unknown>): Promise<string>;
export interface Lesson {
    input?: string;
    lesson: string;
    key?: string;
    at?: number;
}
export interface ReflexionStore {
    list(): Lesson[];
    add(l: Lesson): Lesson;
    recall(input: string, k?: number): Lesson[];
    size(): number;
}
export declare function makeReflexionStore(initial?: Lesson[]): ReflexionStore;
export interface Reflexion {
    store: ReflexionStore;
    getHint(): Promise<string>;
    learn(failure: string): Promise<Lesson>;
}
export declare function attachReflexion(callChat: CallChat, input: unknown, opts?: {
    lessons?: Lesson[];
    memory?: ReflexionStore;
    topK?: number;
    [k: string]: unknown;
}): Reflexion;
export {};
//# sourceMappingURL=reflexion.d.ts.map