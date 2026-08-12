// scripts/benchmarks/run.js
// compare gemma4:31b-cloud plain vs deepthink (depth=3, checks=2) on
// math benchmarks. pulls questions from local jsonl files in
// benchmarks/data/ and writes a per-row csv + a summary table.
//
// each row: bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,dt_seconds
// summary: bench,total,plain_acc,dt_acc,delta
//
// usage:  node scripts/benchmarks/run.js [--bench aime2024|gsm8k|math500|all] [--limit N] [--depth N] [--checks N] [--out path]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', '..', 'benchmarks', 'data');
const MODEL = 'gemma4:31b-cloud';

const want = (k, isBool = false) => {
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${k}`) {
      if (isBool) return true;
      // value may be next arg (space-separated form)
      return process.argv[i + 1] || '';
    }
    if (a.startsWith(`--${k}=`)) return a.split('=').slice(1).join('=');
  }
  return undefined;
};
const benchArg = want('bench') || 'all';
const limitArg = parseInt(want('limit') || '0', 10);
const depth = parseInt(want('depth') || '3', 10);
const checks = parseInt(want('checks') || '2', 10);
const concurrency = parseInt(want('concurrency') || '1', 10);
const outArg = want('out');
const outPath = outArg ? path.resolve(outArg) : path.resolve(__dirname, '..', '..', 'benchmarks', 'results.csv');

function extractAnswer(text) {
  if (!text) return '';
  const t = String(text);
  const box = t.match(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
  if (box) return box[1].trim();
  const tail = t.match(/(?:final\s*answer|answer\s*(?:is|:))\s*[:=]?\s*([^.\n]+)/i);
  if (tail) {
    const cap = tail[1].trim();
    // "ANSWER: [1000]" — the pipeline's bracket format wraps the value
    const unwrap = cap.match(/^\[([^\]]+)\]$/);
    if (unwrap) return unwrap[1].trim();
    // "final answer is m + n = 25 + 8 = 33" — a chain of equalities; the
    // value is the LAST number, not the whole expression
    const chain = cap.match(/(?:=|\b)\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)\s*$/);
    if (chain) return chain[1];
    return cap;
  }
  const nums = t.match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g);
  if (nums && nums.length) return nums[nums.length - 1];
  return t.trim();
}

function norm(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).trim();
  // strip $ , \ whitespace AND brackets/braces — the pipeline answers in
  // "[1000]" form and a bracketed value must match the bare gold
  t = t.replace(/[$,\s\\[\]{}]/g, '').replace(/^0+(?=\d)/, '');
  return t.toLowerCase();
}

function eq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const fa = parseFloat(na);
  const fb = parseFloat(nb);
  if (!isNaN(fa) && !isNaN(fb) && Math.abs(fa - fb) < 1e-6) return true;
  const fa2 = na.split('/');
  const fb2 = nb.split('/');
  if (fa2.length === 2 && fb2.length === 2) {
    const v = parseFloat(fa2[0]) / parseFloat(fa2[1]) - parseFloat(fb2[0]) / parseFloat(fb2[1]);
    if (!isNaN(v) && Math.abs(v) < 1e-6) return true;
  }
  return false;
}

function loadBench(name) {
  const file = path.join(DATA, name + '.jsonl');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function chatPlain(client, prompt) {
  const r = await client.chat({
    model: MODEL,
    messages: [{ role: 'user', content: prompt + '\n\nGive only the final answer, no explanation.' }],
    stream: false,
  });
  return r.content || '';
}

// the ANSWER: system prompt is what triggers the pipeline's OUTPUT FORMAT
// directive — without it dt answers in prose ("final answer is m+n=25+8=33")
// and the extractor can't parse the chain. same contract as freshRun.js.
const DT_SYS = 'You are a precise problem solver. Solve the problem and give ONLY the answer, on a line that starts with "ANSWER: ". Do not include any other text after the answer line.';

async function runOnce(dt, prompt) {
  const r = await dt.generate(prompt, { depth, checks, systemPrompt: DT_SYS });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    return r.answer || r.output || r.content || r.text || r.result || JSON.stringify(r);
  }
  return String(r);
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const t = String(s).replace(/\r?\n/g, ' ').slice(0, 2000);
  if (t.includes(',') || t.includes('"')) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

async function processOne(plain, dt, it) {
  const gold = it.answer || '';
  const prompt = it.problem;

  let plainA = '', dtA = '';
  let plainOk = 0, dtOk = 0, dtSec = 0, pSec = 0;

  try {
    const t0 = Date.now();
    const r = await chatPlain(plain, prompt);
    plainA = extractAnswer(r);
    plainOk = eq(plainA, gold) ? 1 : 0;
    pSec = (Date.now() - t0) / 1000;
  } catch (e) {
    plainA = `ERR:${e.message}`;
  }

  try {
    const t0 = Date.now();
    dtA = await runOnce(dt, prompt);
    dtSec = (Date.now() - t0) / 1000;
    dtOk = eq(extractAnswer(dtA), gold) ? 1 : 0;
  } catch (e) {
    dtA = `ERR:${e.message}`;
  }

  return { it, gold, plainA, plainOk, dtA, dtOk, dtSec, pSec };
}

async function main() {
  console.log(`model:  ${MODEL}`);
  console.log(`depth:  ${depth}`);
  console.log(`checks: ${checks}`);
  console.log(`data:   ${DATA}`);
  console.log(`out:    ${outPath}`);

  const all = ['aime2024', 'gsm8k', 'math500'];
  const benches = benchArg === 'all' ? all : [benchArg];

  // maxConcurrency pins the adaptive limiter's ceiling — the user runs 10
  // ollama threads at a time, so cap request concurrency there
  const dt = new Deepthink(MODEL, [], { provider: 'ollama' }, Infinity, null, { maxConcurrency: Math.max(concurrency, 2) });
  const plain = dt.buildClient(null);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // resume-safe: ids already in the csv are skipped, and the file is
  // appended to instead of truncated (a killed run keeps its rows)
  const doneIds = new Set();
  if (fs.existsSync(outPath)) {
    for (const l of fs.readFileSync(outPath, 'utf-8').split('\n').slice(1)) {
      if (!l.trim()) continue;
      const m = l.match(/^[^,]+,[^,]+/);
      if (m) doneIds.add(m[0].split(',')[1]);
    }
  }
  const out = fs.openSync(outPath, doneIds.size ? 'a' : 'w');
  if (!doneIds.size) fs.writeSync(out, 'bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,dt_seconds\n');

  const summary = [];

  for (const b of benches) {
    const items = loadBench(b);
    const slice = (limitArg > 0 ? items.slice(0, limitArg) : items).filter((it) => !doneIds.has(it.id));
    let pN = 0, dN = 0;
    console.log(`\n== ${b} (${slice.length}/${items.length}, ${doneIds.size} already done) ==`);

    let done = 0;
    const queue = new PQueue({ concurrency });
    await queue.addAll(slice.map((it) => async () => {
      const r = await processOne(plain, dt, it);
      pN += r.plainOk;
      dN += r.dtOk;
      done++;
      console.log(
        `  [${b} ${done}/${slice.length}] plain ${r.pSec.toFixed(1)}s -> ${r.plainOk ? 'OK' : 'X'} (${r.plainA.slice(0, 20)})  dt ${r.dtSec.toFixed(1)}s -> ${r.dtOk ? 'OK' : 'X'} (${String(r.dtA).slice(0, 20)})`
      );

      fs.writeSync(
        out,
        [b, r.it.id, csvEscape(r.gold), csvEscape(r.plainA), r.plainOk, csvEscape(r.dtA), r.dtOk, r.dtSec.toFixed(1)].join(',') + '\n'
      );
    }));

    const tot = slice.length || 1;
    const pAcc = pN / tot;
    const dAcc = dN / tot;
    summary.push({ bench: b, total: tot, plain: pAcc, dt: dAcc, delta: dAcc - pAcc });
    console.log(`  ${b}: plain=${(pAcc * 100).toFixed(1)}%  dt=${(dAcc * 100).toFixed(1)}%  delta=${((dAcc - pAcc) * 100).toFixed(1)}pp`);
  }

  fs.closeSync(out);

  const sumPath = outPath.replace(/\.csv$/, '.summary.json');
  fs.writeFileSync(sumPath, JSON.stringify({ model: MODEL, depth, checks, rows: summary }, null, 2));

  console.log('\n=== summary ===');
  for (const s of summary) {
    console.log(
      `${s.bench.padEnd(10)}  plain=${(s.plain * 100).toFixed(1).padStart(5)}%   dt=${(s.dt * 100).toFixed(1).padStart(5)}%   delta=${s.delta >= 0 ? '+' : ''}${(s.delta * 100).toFixed(1)}pp`
    );
  }
  console.log(`\nwrote ${outPath}`);
  console.log(`wrote ${sumPath}`);

  dt.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
