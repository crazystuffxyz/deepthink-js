// scripts/benchmarks/engineTest.js
// validates the NEW engine contract against a live server:
//   1. probes still emit ANSWER: lines (weighted-vote contract)
//   2. CONFIDENCE: lines parse to real numbers (not all-default 0.5)
//   3. weighted consensus + consensusText come back
//   4. the probe_verdict pass fires and flips the thinkCtx consensus line
//   5. depth-2 wall time stays under ~60s
// usage: node scripts/benchmarks/engineTest.js [--depth 2] [--problem <text>]

import Deepthink from '../../dist/index.js';
import { runThink } from '../../dist/thinking/think.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const MODEL = arg('model', 'gemma4:31b-cloud');
const DEPTH = Number(arg('depth', '2'));
const CHECKS = Number(arg('checks', '1'));
const PROBLEM = arg('problem', 'Find the sum of the 10th terms of all arithmetic sequences of integers that have first term equal to 4 and include both 24 and 34 as terms.');

const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = (msgs, stream, onChunk, opts) => dt.callChat(msgs, stream, onChunk, opts);

// ---- 1-3: probe contract (runThink directly) ----
const t0 = Date.now();
const tr = await runThink(callChat, PROBLEM, DEPTH, { hard: true, codeProbe: true });
const tThink = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[runThink] ${tThink}s`);
console.log(`  probes: ${tr.answers?.length ?? 0}`);
let realConf = 0;
for (const a of tr.answers ?? []) {
  const c = a.conf ?? 0.5;
  if (Math.abs(c - 0.5) > 1e-9) realConf++;
  console.log(`  ${a.tag.padEnd(11)} ANSWER=${String(a.answer).slice(0, 40)} conf=${c}`);
}
console.log(`  conf parse: ${realConf}/${tr.answers?.length ?? 0} non-default ${realConf > 0 ? '✓' : '✗'}`);
console.log(`  consensus: ${tr.consensus ?? '(none)'} agreement=${(tr.agreement ?? 0).toFixed(2)}`);
console.log(`  consensusText: ${tr.consensusText ? (tr.consensusText.length + ' chars') : '(none)'}`);

// ---- 4-5: full pipeline (probe_verdict phase + speed) ----
const t1 = Date.now();
const logs = [];
dt.on('log', (e) => { if (e.source === 'checks' || e.source === 'probe_verdict' || e.source === 'evolved' || e.source === 'think') logs.push(e.msg); });
const out = await dt.generate(PROBLEM, { depth: DEPTH, checks: CHECKS, enableCode: true });
const wall = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`\n[generate] ${wall}s`);
console.log(`  answer: ${String(out).slice(0, 200)}`);
const verdicts = logs.filter((m) => m.includes('consensus'));
console.log(`  probe_verdict: ${verdicts.length ? verdicts[0] : '(none — no consensus path ran) ✗'}`);

const tr2 = dt._lastTrace;
if (tr2) {
  const phases = tr2.events.reduce((a, e) => ((a[e.phase] = (a[e.phase] || 0) + 1), a), {});
  console.log(`  phases: ${JSON.stringify(phases)}`);
  const tok = tr2.events.reduce((a, e) => a + (e.promptTokens || 0) + (e.responseTokens || 0), 0);
  console.log(`  calls: ${tr2.events.length}, tokens: ${tok}`);
  console.log(`  probe_verdict phase present: ${phases.probe_verdict ? '✓' : '✗'}`);
  console.log(`  final consistency skipped when consensus trusted: ${phases.consistency ? 'ran' : 'skipped (expected when consensus trusted)'}`);
}
dt.destroy();
console.log('\nengine test done');
