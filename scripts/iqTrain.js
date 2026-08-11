// scripts/iqTrain.js
// IQ training loop — evolve the system prompt like a neural net:
//   80% train  = IQ banks (benchmarks/data/iqTrain.jsonl, 25 items)
//   20% test   = fresh untrained set (benchmarks/data/freshSet.jsonl, 35 items)
//               used ONLY as the OOD holdout probe after training.
//
// usage:
//   node scripts/iqTrain.js [--pop N] [--gens N] [--model X] [--concurrency N]
//       [--train <jsonl>] [--ood <jsonl>]   (override the banks — e.g. retrain
//        on aime-2026-I.jsonl with aime-2026-II.jsonl as the OOD holdout)
//
// output:
//   benchmarks/evolved/iq/<runId>/population-gen-*.json
//   benchmarks/evolved/iq/<runId>/summary.json   (best prompt + OOD score)
//   benchmarks/evolved/iq/<runId>/ood-score.json (generalization gap)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink, { evolvePrompts } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'benchmarks');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'evolved', 'iq');
fs.mkdirSync(OUT, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const POP = Number(arg('pop', '8'));
const GENS = Number(arg('gens', '6'));
const CONCURRENCY = Number(arg('concurrency', process.env.BENCH_CONCURRENCY || '2'));
const EVAL_SAMPLE = Number(arg('sample', process.env.BENCH_EVAL_SAMPLE || '0')); // mini-batch size (0 = full bank)

// ---- train bench: IQ banks (kind 'choice', reference = 1-based choice index)
// --train overrides with a jsonl of {id, problem, answer} (aime-2026-* format)
function loadBench(file) {
  const items = fs.readFileSync(path.join(DATA, file), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // aime-style rows: {id, source, kind, problem, answer} → BenchItem
  if (items[0] && items[0].problem && !items[0].prompt) {
    return items.map((o) => ({
      id: o.id, kind: o.kind || 'math', prompt: o.problem,
      reference: Number(o.answer), numericTolerance: 0, weight: 1
    }));
  }
  return items;
}
const TRAIN_FILE = arg('train', 'iqTrain.jsonl');
const OOD_FILE = arg('ood', 'freshSet.jsonl');
const train = loadBench(TRAIN_FILE);

// ---- test holdout: fresh set → BenchItem format
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
const ood = OOD_FILE === 'freshSet.jsonl'
  ? fs.readFileSync(path.join(DATA, 'freshSet.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => toBenchItem(JSON.parse(l)))
  : loadBench(OOD_FILE);

console.log(`[iqTrain] model=${MODEL} pop=${POP} gens=${GENS} concurrency=${CONCURRENCY}`);
console.log(`[iqTrain] train=${train.length} items (${TRAIN_FILE}) | ood test=${ood.length} items (${OOD_FILE})`);

// ---- serialize the bench through a queue so ollama stays calm
const queue = new PQueue({ concurrency: CONCURRENCY });
const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = (msgs, stream, onChunk, opts) => queue.add(() => dt.callChat(msgs, stream, onChunk, opts));

(async () => {
  const t0 = Date.now();
  const { best, runDir, summary, oodScore } = await evolvePrompts(callChat, {
    popSize: POP,
    generations: GENS,
    bench: train,
    oodBench: ood,
    dataDir: OUT,
    runId: 'iq-' + new Date().toISOString().replace(/[:.]/g, '-'),
    tournamentK: 3,
    evalSample: EVAL_SAMPLE
  });
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n[iqTrain] done in ${mins} min`);
  console.log(`[iqTrain] best fitness=${(best.fitness || 0).toFixed(3)} (${best.operator || 'seed'})`);
  console.log(`[iqTrain] OOD (fresh set) fitness=${oodScore == null ? 'n/a' : oodScore.toFixed(3)}`);
  console.log(`[iqTrain] saved ${runDir}`);
  process.exit(0);
})().catch((e) => { console.error('[iqTrain] fatal:', e); process.exit(1); });
