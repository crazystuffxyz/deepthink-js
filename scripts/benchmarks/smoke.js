// scripts/benchmarks/smoke.js
// live smoke test: one deepthink run with trace + adaptive concurrency +
// verifier checks, prints the trace summary so we can see the plumbing works.
// usage: node scripts/benchmarks/smoke.js [--model X] [--verifier Y] [--depth 1] [--checks 1]
import Deepthink from '../../dist/index.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const MODEL = arg('model', 'gemma4:31b-cloud');
const VERIFIER = arg('verifier', 'deepseek-v4-flash:0731-cloud');
const DEPTH = Number(arg('depth', '1'));
const CHECKS = Number(arg('checks', '1'));

const dt = new Deepthink(MODEL, [], { provider: 'ollama' }, Infinity, VERIFIER, { traceMode: 'flat' });
dt.on('log', (e) => {
  if (e.level !== 'info' || e.source !== 'concurrency') return;
  console.log(`  [concurrency] ${e.msg}`);
});

const prompt = arg('prompt', 'What is 47 * 89? Answer with just the number in [brackets].');

console.log(`smoke: model=${MODEL} verifier=${VERIFIER} depth=${DEPTH} checks=${CHECKS}`);
console.log(`prompt: ${prompt}`);
const t0 = Date.now();
const out = await dt.generate(prompt, { depth: DEPTH, checks: CHECKS });
const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nanswer: ${String(out).slice(0, 300)}`);
console.log(`wall: ${wall}s`);

const tr = dt._lastTrace;
if (!tr) {
  console.log('\nNO TRACE — plumbing broken!');
  process.exit(1);
}
console.log(`\ntrace summary: ${tr.summarize()}`);
console.log(`phases: ${JSON.stringify(tr.events.reduce((a, e) => ((a[e.phase] = (a[e.phase] || 0) + 1), a), {}))}`);
console.log(`per-call detail:`);
for (const e of tr.events) {
  console.log(`  #${e.callId} ${e.phase} ${e.model} ${e.latencyMs}ms ${e.promptTokens ?? '?'}in/${e.responseTokens ?? '?'}out status=${e.status} conc=${e.concurrency}`);
}
const withTok = tr.events.filter((e) => e.promptTokens != null).length;
console.log(`token capture: ${withTok}/${tr.events.length} calls have token counts ${withTok === tr.events.length ? '✓' : '✗'}`);
console.log(`concurrency level: ${dt.concurrencyScaler?.current ?? 'n/a'}`);
dt.destroy();
