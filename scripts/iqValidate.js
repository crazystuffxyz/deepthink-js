// scripts/iqValidate.js — apply the best evolved prompt to the holdout sets
// (iqHard + freshSet) and grade against the answer keys. the point: prove the
// evolved prompt generalizes OOD (freshSet was never in the train bank) and
// fixes the known weak spot (iqHard h04, the HH-vs-HT problem).
//
// NOTE: this is the SINGLE-SHOT harness (no pipeline, no checks). the honest
// full-pipeline measurement is scripts/benchmarks/freshRun.js --evolved <runDir>
// — that one carries the ANSWER: pin (PLAIN_SYS) and the deepthink pipeline,
// exactly like the 19/20 baseline was measured. this script exists for fast
// iteration and now applies the SAME pin so numbers are comparable.
//
// usage:
//   node scripts/iqValidate.js <runId> [--sets iqHard,freshSet] [--concurrency N]
//   node scripts/iqValidate.js --control [--sets iqHard,freshSet]  (default prompt, no evolution)
//
// output:
//   benchmarks/evolved/iq/<runId>/validate-<set>.json  (per-item + aggregate)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink from '../dist/thinking/deepthink.js';
import { loadBest } from '../dist/thinking/evolvedThinking.js';
import { parseAnswer, answersMatch } from './benchmarks/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'benchmarks', 'data');
const OUT = path.join(ROOT, 'benchmarks', 'evolved', 'iq');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const CONTROL = process.argv.includes('--control');
const runId = CONTROL ? 'control' : process.argv[2];
if (!runId) { console.error('usage: node scripts/iqValidate.js <runId> [--sets iqHard,freshSet]'); process.exit(1); }
const runDir = CONTROL ? null : path.join(OUT, runId);
if (!CONTROL && !fs.existsSync(runDir)) { console.error(`no run dir: ${runDir}`); process.exit(1); }
const SETS = (arg('sets', 'iqHard,freshSet') || '').split(',').map(s => s.trim()).filter(Boolean);
const CONCURRENCY = Number(arg('concurrency', '2'));
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');

// same pin freshRun.js uses — the honest baseline measured with this exact
// system prompt. without it the model rambles in prose and no grader can
// find the answer line.
const PIN_SYS = 'You are a precise problem solver. Solve the problem and give ONLY the answer, on a line that starts with "ANSWER: ". If the problem lists numbered choices, answer with the choice number only (e.g. "ANSWER: 3"). Do not include any other text after the answer line.';

let best = null;
if (!CONTROL) {
  best = loadBest(runDir);
  console.log(`[iqValidate] best: ${best.id} fitness=${(best.fitness || 0).toFixed(3)} op=${best.operator || 'seed'}`);
  console.log(`[iqValidate] sysLen=${best.systemPrompt.length} sets=${SETS.join(',')} concurrency=${CONCURRENCY}`);
} else {
  console.log(`[iqValidate] CONTROL: default system prompt, sets=${SETS.join(',')}`);
}

// same conversion as iqTrain.js — freshSet items are heterogeneous
function toBenchItem(o) {
  const a = String(o.answer).trim();
  if (/^\d+(\.\d+)?$/.test(a)) return { id: o.id, kind: 'math', prompt: o.prompt, reference: parseFloat(a), numericTolerance: 0.01, weight: 1 };
  if (/^\d+ and \d+$/.test(a)) {
    const [x, y] = a.split(' and ').map(Number);
    return { id: o.id, kind: 'math', prompt: o.prompt, reference: { a0: x, a1: y }, numericTolerance: 0.01, weight: 1 };
  }
  if (/^\d+\/\d+$/.test(a)) {
    const [n, d] = a.split('/').map(Number);
    return { id: o.id, kind: 'math', prompt: o.prompt, reference: n / d, numericTolerance: 0.01, weight: 1 };
  }
  if (/^\d+:\d+/.test(a)) return { id: o.id, kind: 'math', prompt: o.prompt, reference: { time: a }, numericTolerance: 0.01, weight: 1 };
  if (/^[A-Za-z]$/.test(a)) return { id: o.id, kind: 'letter', prompt: o.prompt, reference: a, weight: 1 };
  return { id: o.id, kind: 'deduction', prompt: o.prompt, reference: a.toLowerCase(), weight: 1 };
}

// grade a single answer — mirrors freshRun's parseAnswer/answersMatch so the
// single-shot numbers are comparable to the baseline table
function gradeOne(text, item) {
  const cands = parseAnswer(text);
  const ok = answersMatch(cands, item.reference ?? item.answer);
  return { ok, got: cands[0] ?? null, want: String(item.reference ?? item.answer) };
}

const queue = new PQueue({ concurrency: CONCURRENCY });
const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = (msgs, stream, onChunk, opts) => queue.add(() => dt.callChat(msgs, stream, onChunk, opts));

async function runOne(item) {
  // same sampling as the baseline's "plain" row (think off, temp 0.2),
  // system slot = persona + the format pin, exactly like the pipeline
  // consolidates its system messages.
  const sys = CONTROL ? PIN_SYS : best.systemPrompt + '\n\n' + PIN_SYS;
  const r = await callChat(
    [{ role: 'system', content: sys }, { role: 'user', content: item.prompt }],
    false, null,
    { think: false, autoSystemPrompt: false, temperature: 0.2 }
  );
  return r.content || '';
}

(async () => {
  const t0 = Date.now();
  const results = {};
  for (const set of SETS) {
    const file = path.join(DATA, `${set}.jsonl`);
    if (!fs.existsSync(file)) { console.error(`no data file: ${file}`); continue; }
    const items = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => {
      const o = JSON.parse(l);
      // iqHard/iqTest items are already BenchItem-shaped (kind/reference)
      return o.kind && o.reference != null ? o : toBenchItem(o);
    });
    console.log(`[iqValidate] ${set}: ${items.length} items`);
    const rows = [];
    for (const item of items) {
      const out = await runOne(item);
      const g = gradeOne(out, item);
      rows.push({ id: item.id, kind: item.kind, ok: g.ok ? 1 : 0, got: g.got, want: g.want, ms: 0, raw: out.slice(0, 400) });
      console.log(`  ${g.ok ? 'ok ' : 'FAIL'} ${item.id} (${item.kind}) got=${JSON.stringify(g.got)} want=${JSON.stringify(g.want)}`);
    }
    const correct = rows.filter(r => r.ok).length;
    results[set] = { n: items.length, correct, pct: Math.round(1000 * correct / items.length) / 10, rows };
    const outFile = path.join(CONTROL ? path.join(OUT, 'control') : runDir, `validate-${set}.json`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(results[set], null, 2), 'utf-8');
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n[iqValidate] done in ${mins} min`);
  for (const [set, r] of Object.entries(results)) {
    console.log(`[iqValidate] ${set}: ${r.correct}/${r.n} (${r.pct}%)`);
  }
  await dt.destroy();
  process.exit(0);
})().catch((e) => { console.error('[iqValidate] fatal:', e); process.exit(1); });
