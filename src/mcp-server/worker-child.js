// src/mcp-server/worker-child.js
// the subprocess half of JsWorkerPool. reads {id, code, state} lines on
// stdin, runs the code with `state` in scope, writes {id, ok, result,
// state, error} back on stdout. one job per line, one result per line.
//
// security: this process is disposable — the pool kills + respawns it on
// crash or timeout, so hostile code can't poison the server itself.
'use strict';

// user code must not touch real stdout — corrupts the line protocol.
// redirect stdout + console into a buffer for the job, ship it back in
// the result so callers still see the output.
const realStdout = process.stdout.write.bind(process.stdout);
const realConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(msg) {
  const { id, code, state } = msg;
  const stolen = [];
  const capture = (s) => {
    stolen.push(String(s));
    return true;
  };
  process.stdout.write = capture;
  const variadic = (...a) => capture(a.map(String).join(' ') + '\n');
  console.log = variadic;
  console.error = variadic;
  console.warn = variadic;
  console.info = variadic;
  console.debug = variadic;
  const sandbox = state && typeof state === 'object' ? { ...state } : {};
  // shadow the dangerous globals — user code gets `undefined` for all of
  // them. process would leak env vars (api keys), require/module/exports
  // would unlock the whole fs, global/globalThis would let code walk back
  // out of the sandbox entirely.
  const SHADOWED = [
    'process',
    'require',
    'module',
    'exports',
    'global',
    'globalThis',
    'Buffer',
    'setImmediate',
    'queueMicrotask',
  ];
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('state', ...SHADOWED, `return (async () => { ${code} })();`);
    const result = await fn(sandbox, ...SHADOWED.map(() => undefined));
    realStdout(
      JSON.stringify({ id, ok: true, result: result ?? null, state: sandbox, output: stolen.join('') }) + '\n',
    );
  } catch (e) {
    // ship the mutated state back even on error — retries need prior progress
    realStdout(
      JSON.stringify({ id, ok: false, error: e.message, stack: e.stack, state: sandbox, output: stolen.join('') }) +
        '\n',
    );
  } finally {
    process.stdout.write = realStdout;
    console.log = realConsole.log;
    console.error = realConsole.error;
    console.warn = realConsole.warn;
    console.info = realConsole.info;
    console.debug = realConsole.debug;
  }
}
