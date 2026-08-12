// scripts/smokeA26ii13.js
// one-problem smoke test: a26ii-13 through the CURRENT dist build.
// verifies the robust-parse fix — codegen must run (trace shows codegen
// events) and the sandbox must land on 107.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'benchmarks', 'data', 'aime-2026-II.jsonl');
const MODEL = 'gemma4:31b-cloud';

const lines = fs.readFileSync(DATA, 'utf-8').trim().split('\n');
const row = JSON.parse(lines.find(l => JSON.parse(l).id === 'a26ii-13'));

const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const t0 = Date.now();
const r = await dt.generate(row.problem, { depth: 2, checks: 1, systemPrompt: 'You are a math problem solver. Answer with the final number only.' });
const ms = Date.now() - t0;

const out = typeof r === 'string' ? r : (r && (r.answer || r.output || r.content || r.text || r.result)) || JSON.stringify(r);
console.log(`\n[smoke] a26ii-13 in ${(ms / 1000).toFixed(1)}s`);
console.log(`[smoke] answer head: ${String(out).slice(0, 120)}`);
console.log(`[smoke] answer tail: ${String(out).slice(-160)}`);
console.log(`[smoke] gold:   107`);

// trace check — the store lives on _lastTrace (no getTrace method)
const trace = dt._lastTrace || null;
if (trace && trace.events) {
  const phases = {};
  for (const e of trace.events) phases[e.phase] = (phases[e.phase] || 0) + 1;
  console.log(`[smoke] trace phases: ${JSON.stringify(phases)}`);
  const codegen = trace.events.filter(e => e.phase === 'codegen');
  console.log(`[smoke] codegen events: ${codegen.length}`);
  const compute = trace.events.find(e => e.phase === 'compute');
  if (compute) {
    try {
      const p = JSON.parse(compute.response);
      console.log(`[smoke] compute parsed: mode=${p.mode} taskLen=${(p.task || '').length}`);
    } catch (e) {
      console.log(`[smoke] compute STILL unparseable: ${e.message.slice(0, 80)}`);
    }
  }
} else {
  console.log('[smoke] no trace available');
}
