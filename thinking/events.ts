// thinking/events.ts
// module-level emitter for pipeline logs. Deepthink subscribes and
// re-emits on its own EventEmitter so dt.on('log', …) sees everything.
import { EventEmitter } from 'node:events';
import type { LogEvent, LogLevel } from './types.js';

export { EventEmitter };

export const globalEmitter = new EventEmitter();
globalEmitter.setMaxListeners(100);

export function log(e: LogEvent): void {
  globalEmitter.emit('log', e);
}

export function onLog(fn: (e: LogEvent) => void): () => void {
  globalEmitter.on('log', fn);
  return () => globalEmitter.off('log', fn);
}

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
  success: '\x1b[32m'
};
const RESET = '\x1b[0m';

export function makeConsoleLogger(useColor = true): (e: LogEvent) => void {
  return (e) => {
    const ts = new Date(e.ts ?? Date.now()).toISOString().slice(11, 19);
    const c = useColor ? COLORS[e.level] : '';
    const r = useColor ? RESET : '';
    const src = e.source ? ` [${e.source}]` : '';
    const line = `${c}${ts} ${e.level.toUpperCase()}${r}${src} ${e.msg}`;
    if (e.level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
}

export function makeSilentLogger(): (e: LogEvent) => void {
  return () => {};
}
