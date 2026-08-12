// scripts/traceAnalyze.js
// summarize a saved diagnostic trace: per-phase call counts, tokens, latency.
//   node scripts/traceAnalyze.js benchmarks/results/putnam-diag/p2025-A6.json
// reads the dt.trace array inside a per-item diagnostic JSON.

import fs from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/traceAnalyze.js <item.json>'); process.exit(1); }
const row = JSON.parse(fs.readFileSync(file, 'utf-8'));
const trace = row.dt?.trace;
if (!trace || !trace.length) { console.error('no dt.trace in ' + file); process.exit(1); }

const byPhase = {};
for (const e of trace) {
  const p = byPhase[e.phase] || (byPhase[e.phase] = { calls: 0, ms: 0, in: 0, out: 0, errs: 0 });
  p.calls++;
  p.ms += e.latencyMs || 0;
  p.in += e.promptTokens || 0;
  p.out += e.responseTokens || 0;
  if (e.status !== 'ok') p.errs++;
}
const totalMs = trace.reduce((a, e) => a + (e.latencyMs || 0), 0);
console.log(`trace: ${trace.length} calls, ${(totalMs / 1000).toFixed(1)}s total, model=${trace[0]?.model}`);
console.log('phase        calls    sec   inTok  outTok  errs');
for (const [phase, p] of Object.entries(byPhase).sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`${phase.padEnd(12)} ${String(p.calls).padStart(4)} ${(p.ms / 1000).toFixed(1).padStart(6)} ${String(p.in).padStart(6)} ${String(p.out).padStart(6)} ${String(p.errs).padStart(4)}`);
}
// per-call detail for the slowest phases
const slow = trace.filter(e => (e.latencyMs || 0) > 5000).sort((a, b) => (b.latencyMs || 0) - (a.latencyMs || 0));
if (slow.length) {
  console.log('\nslowest calls:');
  for (const e of slow.slice(0, 8)) {
    console.log(`  #${e.callId} ${e.phase} ${(e.latencyMs / 1000).toFixed(1)}s ${e.promptTokens || 0}in/${e.responseTokens || 0}out ${e.status}${e.error ? ' ERR:' + String(e.error).slice(0, 80) : ''}`);
  }
}
