import { EventEmitter } from 'node:events';
import type { LogEvent } from './types.js';
export { EventEmitter };
export declare const globalEmitter: EventEmitter<[never]>;
export declare function log(e: LogEvent): void;
export declare function onLog(fn: (e: LogEvent) => void): () => void;
export declare function makeConsoleLogger(useColor?: boolean): (e: LogEvent) => void;
export declare function makeSilentLogger(): (e: LogEvent) => void;
//# sourceMappingURL=events.d.ts.map