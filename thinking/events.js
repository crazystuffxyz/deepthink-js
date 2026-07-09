// thinking/events.ts
import { EventEmitter } from 'node:events';
export { EventEmitter };
// module-level emitter so non-class code (researchAgent, codeGenerator) can
// publish log events without owning an instance. silent by default.
const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);
export function log(e) {
    _emitter.emit('log', e);
}
export function onLog(fn) {
    _emitter.on('log', fn);
    return () => _emitter.off('log', fn);
}
const COLORS = {
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    debug: '\x1b[90m',
    success: '\x1b[32m'
};
const RESET = '\x1b[0m';
export function makeConsoleLogger(useColor = true) {
    return (e) => {
        const ts = new Date(e.ts ?? Date.now()).toISOString().slice(11, 19);
        const c = useColor ? COLORS[e.level] : '';
        const r = useColor ? RESET : '';
        const src = e.source ? ` [${e.source}]` : '';
        const line = `${c}${ts} ${e.level.toUpperCase()}${r}${src} ${e.msg}`;
        if (e.level === 'error')
            process.stderr.write(line + '\n');
        else
            process.stdout.write(line + '\n');
    };
}
export function makeSilentLogger() {
    return () => { };
}
