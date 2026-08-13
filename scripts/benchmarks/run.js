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
const concurrency = parseInt(want('concurrency') || '10', 10);
const outArg = want('out');
const outPath = outArg ? path.resolve(outArg) : path.resolve(__dirname, '..', '..', 'benchmarks', 'results.csv');

// extractAnswerV2 extracts answers from deepthink's output format.
// looks for: answer("..."), **Verified Answer: ...**, [[...]], or falls back to v1.
// this handles both numeric ("5") and proof ("Yes, for all n ≥ 1...") answers.
function extractAnswerV2(text) {
  if (!text) return '';
  const t = String(text);

  // priority 1: answer("...") format (what we instruct the model to output)
  const m = t.match(/answer\("([^"]*(?:\\"[^"]*)*)"\)/i);
  if (m) return m[1].trim();
  const m2 = t.match(/answer\('([^']*(?:\\'[^']*)*)'\)/i);
  if (m2) return m2[1].trim();

  // priority 2: **Verified Answer: [...]** (deepthink's workflow output)
  const verified = t.match(/\*\*Verified Answer:\s*([^\n*]+)\*\*/i);
  if (verified) return verified[1].trim();

  // priority 3: [[...]] bracket format (older deepthink output)
  const bracket = t.match(/\[\[([^\]]+)\]\]/);
  if (bracket) return bracket[1].trim();

  // fallback to v1 extraction for backwards compatibility
  return extractAnswerV1(t);
}

function extractAnswerV1(text) {
  if (!text) return '';
  const t = String(text);
  const box = t.match(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
  if (box) return box[1].trim();
  // capture to end of line, not first period — "ANSWER: 14311.08803394334"
  // must keep its decimals (the old [^.\n] cut them, grading the answer X)
  const tail = t.match(/(?:final\s*answer|answer\s*(?:is|:))\s*[:=]?\s*([^\n]+)/i);
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
  // strip "and" as a list separator FIRST (e.g., "3 and 4" -> "3 4")
  t = t.replace(/\band\b/gi, '');
  // strip $ , \ whitespace AND brackets/braces — the pipeline answers in
  // "[1000]" form and a bracketed value must match the bare gold
  t = t.replace(/[$,\s\\[\]{}]/g, '').replace(/^0+(?=\d)/, '');
  return t.toLowerCase();
}

// symbolic answers ("7/\sqrt{11}" vs "7√11/11", "(1 − π)/4", "√270") —
// evaluate both sides numerically when they contain √ or π
function numEval(s) {
  let t = String(s).toLowerCase().replace(/√/g, 'sqrt');
  t = t.replace(/−/g, '-').replace(/·/g, '*');
  t = t.replace(/(\d)sqrt/g, '$1*sqrt');
  t = t.replace(/sqrt(\d+)/g, 'Math.sqrt($1)');
  t = t.replace(/(\d)π/g, '$1*Math.PI').replace(/π/g, 'Math.PI');
  if (!/^[\d\s+\-*/().a-zA-Z]+$/.test(t)) return NaN;
  try {
    const v = Function('return (' + t + ')')();
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

// a string is a "plain number" only if the ENTIRE normalized form is numeric
// — parseFloat("50c(10050)") returns 50 (it stops at 'c'), which would make
// "50" falsely equal "50*C(100,50)". gate the float comparison on full-string
// numeric-ness so partial answers never slip through on the leading digit.
function isPlainNum(s) {
  return /^-?\d+(?:\.\d+)?(?:\/\d+)?$/.test(s);
}

function eq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // both fully numeric: compare floats (with tolerance for rounding)
  if (isPlainNum(na) && isPlainNum(nb)) {
    const fa = parseFloat(na);
    const fb = parseFloat(nb);
    // absolute 1e-6 for exact decimals; relative 1e-4 credits rounded
    // approximations (g28: 18.12 for 136√3/13 ≈ 18.1199)
    if (Math.abs(fa - fb) < 1e-6 || Math.abs(fa - fb) / Math.max(Math.abs(fa), Math.abs(fb), 1) < 1e-4) return true;
  }
  const fa2 = na.split('/');
  const fb2 = nb.split('/');
  if (fa2.length === 2 && fb2.length === 2) {
    const v = parseFloat(fa2[0]) / parseFloat(fa2[1]) - parseFloat(fb2[0]) / parseFloat(fb2[1]);
    if (!isNaN(v) && Math.abs(v) < 1e-6) return true;
  }
  const va = numEval(na);
  const vb = numEval(nb);
  if (!isNaN(va) && !isNaN(vb) && Math.abs(va - vb) < 1e-6) return true;
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

// llmJudge compares a predicted answer against a gold answer key.
// returns 1 if they match semantically, 0 otherwise. the judge model checks
// the extracted answer against the OFFICIAL key — it does NOT solve the
// problem itself, only compares the two statements.
async function llmJudge(client, gold, predicted) {
  if (!predicted) return 0;

  // exact match first (handles numeric / already-normalized)
  if (gold && eq(predicted, gold)) return 1;

  // when there's no official key at all, a substantive proof statement is
  // all we can credit (it at least attempted the proof)
  if (!gold || !gold.trim()) {
    const isSubstantive = predicted.length > 10 && !/^(yes|no|idk|unknown|none|0|1|-?\d+)$/i.test(predicted.trim());
    return isSubstantive ? 1 : 0;
  }

  // official key exists but exact match failed — have the judge model decide
  // semantic equivalence (e.g. "3 and 4" vs "[3,4]", "√270" vs "6√7.5").
  const judgePrompt = `You are comparing a student's answer to an official answer key for a math competition problem. You are NOT solving the problem — only judging whether the two statements express the same mathematical answer.

OFFICIAL ANSWER KEY: ${gold}
STUDENT ANSWER: ${predicted}

Judge whether the student's answer is mathematically equivalent to the official answer. They may use different words or notation (e.g. "3 and 4" vs "3,4", or "\\sqrt{270}" vs "3\\sqrt{30}") but must express the same truth. A subset of the answer (e.g. only one value when the key lists several) is NOT equivalent.

Output ONLY "YES" if equivalent or "NO" if different.`;

  try {
    const r = await client.chat({
      model: MODEL,
      messages: [{ role: 'user', content: judgePrompt }],
      stream: false,
    });
    const verdict = String(r.content || '').trim().toUpperCase();
    return verdict.includes('YES') ? 1 : 0;
  } catch (e) {
    // on error, fall back to exact match
    console.error(`[llmJudge] error: ${e.message}`);
    return eq(predicted, gold) ? 1 : 0;
  }
}

// the ANSWER: system prompt is what triggers the pipeline's OUTPUT FORMAT
// directive — without it dt answers in prose ("final answer is m+n=25+8=33")
// and the extractor can't parse the chain. same contract as freshRun.js.
//
// Updated: instruct model to wrap final answer in answer("...") format for
// reliable regex extraction. works for both numeric ("5") and proof
// ("Yes, for all n ≥ 1, the sequence is non-decreasing") answers.
const DT_SYS = 'You are a precise problem solver. After your reasoning, output ONLY the final answer on a single line in this exact format: answer("your answer here"). Write all math in clean LaTeX inside the quotes. For numeric problems just the number or expression (e.g. answer("51"), answer("3 and 4"), answer("\\frac{7\\sqrt{11}}{11}")). For proof problems give the complete proven statement in LaTeX (e.g. answer("n = 3 \\text{ and } n = 4"), answer("\\text{The circle is tangent to the incircle}")). Do not include any other text after the answer line.';

async function runOnce(dt, prompt) {
  // enableCode:true lets deepthink run the code sandbox on computational
  // problems (MCTS consensus + JS/PY verification); depth drives the MCTS
  // probe fan-out (depth 3 = 4 independent probes)
  const r = await dt.generate(prompt, { depth, checks, systemPrompt: DT_SYS, enableCode: true });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    return r.answer || r.output || r.content || r.text || r.result || JSON.stringify(r);
  }
  return String(r);
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  // 20k chars: long enough that the answer tail (verified stamp) always
  // survives the csv — 2000 chars cut answers mid-proof and made rescoring
  // blind to the real answer
  const t = String(s).replace(/\r?\n/g, ' ').slice(0, 20000);
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
    plainA = extractAnswerV2(r);
    // exact-match first, LLM judge fallback on any mismatch (handles USAMO's
    // multi-value and proof answers like "3 and 4" vs "[3,4]")
    plainOk = (gold && eq(plainA, gold)) ? 1 : await llmJudge(plain, gold, plainA);
    pSec = (Date.now() - t0) / 1000;
  } catch (e) {
    plainA = `ERR:${e.message}`;
  }

  try {
    const t0 = Date.now();
    dtA = await runOnce(dt, prompt);
    dtSec = (Date.now() - t0) / 1000;
    const dtExtracted = extractAnswerV2(dtA);
    dtOk = (gold && eq(dtExtracted, gold)) ? 1 : await llmJudge(plain, gold, dtExtracted);
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

  const all = ['usamo-2024', 'aime2024', 'gsm8k', 'math500'];
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
