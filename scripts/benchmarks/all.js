// scripts/benchmarks/all.js
// the master orchestrator. runs every benchmark and prints a single
// comparison table.
//
//   - AIME 2024-I + 2024-II + 2023-I (integer answers, sympy-checked)
//   - USAMO 2024 (3 numeric + 3 proof)
//   - IMO 2024 (all proof; keyword-gate verifier)
//   - Integration Bee (1 definite + 1 indefinite, sympy)
//   - Coding (single HTML, plain ollama vs deepthink d=3 c=2)
//
// test model (MODEL) is the one being benchmarked; every deepthink check
// runs against the verifier model (CRITIQUE_MODEL), so self-correction is
// audited by a different brain than the one being tested.
//
// per-problem telemetry: every deepthink run leaves a trace JSON in
// benchmarks/results/traces/ (calls, phases, tokens, latency, errors) so
// reasoning quality and token efficiency are scored offline, not guessed.
//
// usage:
//   node scripts/benchmarks/all.js [--model X] [--verifier Y] [--depth N]
//       [--checks N] [--concurrency N] [--limit N] [--plan a,b,c] [--fresh]
//
// output:
//   benchmarks/results/all.csv
//   benchmarks/results/all.summary.json
//   benchmarks/results/all.table.md
//   benchmarks/results/traces/*.json
//   console: a single markdown table
//
// all.js exits 0 even on benchmark errors — it just records them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink, { TraceStore, runPythonSandbox } from '../../dist/index.js';
import { verify } from './verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const DATA = path.join(ROOT, 'data');
const RES = path.join(ROOT, 'results');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const CRITIQUE_MODEL = arg('verifier', process.env.BENCH_VERIFIER || 'deepseek-v4-flash:0731-cloud');
const DEPTH = Number(arg('depth', process.env.BENCH_DEPTH || '2'));
const CHECKS = Number(arg('checks', process.env.BENCH_CHECKS || '2'));
const CHECK_STYLE = arg('checkStyle', 'full');
const CONCURRENCY = Number(arg('concurrency', process.env.BENCH_CONCURRENCY || '2'));
const LIMIT = Number(arg('limit', '0'));
const PLAN_FILTER = arg('plan', '').split(',').map((s) => s.trim()).filter(Boolean);
const FRESH = process.argv.includes('--fresh');

// exact-answer-only suffix for the proof contests and the integration bee.
// the user wants radicals/exponents/known-irrationals/integers/+−×÷/fractions
// only — no decimals.
const EXACT_SUFFIX = `\n\nIMPORTANT: Express the answer in EXACT form only. Use:
  - integers (e.g. 51, 20000, 3)
  - fractions (e.g. 1/2, 204/7)
  - radicals (sqrt(2), sqrt(3)/2, 1+sqrt(5))
  - known irrationals (pi, e)
  - exponents (2**10, sqrt(2)**3)
  - addition, subtraction, multiplication, division
Do NOT use decimal approximations. If the answer is an integer, give the integer.
Format your final answer as [bracketed] on its own line at the end of your response, e.g. [42] or [sqrt(2)/2] or [pi/2].`;

const BENCH_PLAN = [
  { bench: 'aime-2024-I', file: 'aime-2024-I.jsonl', label: 'AIME 2024 I', limit: 5, exact: true },
  { bench: 'aime-2024-II', file: 'aime-2024-II.jsonl', label: 'AIME 2024 II', limit: 5, exact: true },
  { bench: 'aime-2023-I', file: 'aime-2023-I.jsonl', label: 'AIME 2023 I', limit: 5, exact: true },
  { bench: 'usamo-2024', file: 'usamo-2024.jsonl', label: 'USAMO 2024', limit: 6, exact: true },
  { bench: 'imo-2024', file: 'imo-2024.jsonl', label: 'IMO 2024', limit: 6, exact: true },
  { bench: 'integration-bee', file: 'integrationBee.jsonl', label: 'Integration Bee', limit: 2, exact: true },
  // MBPP = python code-gen. the hidden tests assert on a specific function
  // name, so the prompt names it (calling contract, not an answer leak).
  // verification runs the model's code + asserts through the python sandbox.
  { bench: 'mbpp', file: 'mbpp.jsonl', label: 'MBPP', limit: 5, exact: false },
];

function loadBench(name) {
  const fn = name.endsWith('.jsonl') ? name : name + '.jsonl';
  const fp = path.join(DATA, fn);
  if (!fs.existsSync(fp)) throw new Error(`missing ${fp}`);
  return fs
    .readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// quote-aware csv line split — model answers are prose and contain commas,
// so naive split() misaligns columns (broke resumed-row aggregates).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const t = String(s).replace(/\r?\n/g, ' ').slice(0, 4000);
  if (t.includes(',') || t.includes('"') || t.includes('\n')) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

function buildPrompt(row, exact) {
  let p = row.problem;
  if (row.kind === 'int-definite' || row.kind === 'int-indefinite' || exact) {
    p += EXACT_SUFFIX;
  }
  return p;
}

// MBPP: the hidden tests call a specific function name that the problem
// text doesn't state (e.g. remove_Occ). name it in the prompt — that's the
// calling contract, same as real MBPP evals. never an answer leak.
function mbppName(row) {
  const m = (row.tests || [])[0]?.match(/assert\s+(\w+)\s*\(/);
  return m ? m[1] : '';
}

// pull the code out of a model response: first fenced block, else the whole
// text minus any trailing [bracket] answer line.
function codeFromText(text) {
  if (!text) return '';
  const s = String(text);
  const fence = s.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1];
  return s.replace(/\[\s*[^\]]*\s*\]\s*$/m, '').trim();
}

// run the model's code against the row's hidden asserts in the python
// sandbox. exact-name pass first; if the model picked a differently-cased
// def name, retry with the tests re-pointed at it (still same logic — the
// casing mismatch is a naming artifact, not a solution defect).
async function verifyCode(row, modelText) {
  const code = codeFromText(modelText);
  if (!code) return { ok: false, reason: 'no code found' };
  const tests = row.tests || [];
  const script = [row.test_setup || '', code, ...tests].join('\n');
  const runs = [script];
  const defName = code.match(/def\s+(\w+)/)?.[1];
  const wantName = mbppName(row);
  if (defName && wantName && defName !== wantName) {
    runs.push([row.test_setup || '', code, ...tests.map((t) => t.split(wantName).join(defName))].join('\n'));
  }
  let lastErr = 'tests failed';
  for (const s of runs) {
    try {
      await runPythonSandbox(s);
      return { ok: true, reason: 'tests pass' };
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 80);
    }
  }
  return { ok: false, reason: lastErr };
}

async function withTimeout(fn, ms) {
  // clear the race timer on settle so a finished run isn't kept alive
  // by its losing timeout (hangs the process up to `ms` after done).
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, label = 'call', attempts = 5, timeoutMs = 15 * 60_000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (e) {
      lastErr = e;
      const wait = 1000 * Math.pow(2, i); // 1s, 2s, 4s
      console.log(`    [retry ${i + 1}/${attempts}] ${label} failed: ${e.message?.slice(0, 80) || e}. waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function chatPlain(client, prompt) {
  const r = await withRetry(
    () => client.chat({
      model: MODEL,
      messages: [{ role: 'user', content: prompt + '\n\nGive only the final answer, no explanation.' }],
      stream: false,
    }),
    'chatPlain'
  );
  return (r && r.content) || '';
}

// run with a caller-owned TraceStore so concurrent problems never race
// on the shared dt._lastTrace. the store survives retries and is returned
// for the telemetry writer.
async function runOnce(dt, prompt, opts = {}) {
  const myTrace = new TraceStore('flat', 500);
  const r = await withRetry(
    () => dt.generate(prompt, { depth: DEPTH, checks: CHECKS, checkStyle: CHECK_STYLE, answerFormat: 'bracket', _trace: myTrace, ...opts }),
    'dt.generate'
  );
  const answer = typeof r === 'string' ? r : (r && typeof r === 'object') ? (r.answer || r.output || r.content || r.text || r.result || JSON.stringify(r)) : String(r);
  return { answer, trace: myTrace };
}

// code plans (mbpp) don't want the [value] bracket directive — the answer
// IS the code block — and their correctness is test-execution, not sympy.
function verifyAnswer(plan, row, modelText) {
  if (plan.bench === 'mbpp') return verifyCode(row, modelText);
  return verify({ row, modelText });
}

// extract 4-dimension telemetry from a finished trace. returns zeros when
// tracing is off or the run failed before any LLM call.
function traceStats(store) {
  const t = store;
  if (!t || !t.size) {
    return { calls: 0, tokIn: 0, tokOut: 0, llmMs: 0, errors: 0, checks: 0, revisions: 0, phases: {} };
  }
  const evs = t.events;
  let tokIn = 0, tokOut = 0, llmMs = 0, errors = 0, checks = 0, revisions = 0;
  const phases = {};
  for (const e of evs) {
    tokIn += e.promptTokens || 0;
    tokOut += e.responseTokens || 0;
    llmMs += e.latencyMs || 0;
    if (e.status !== 'ok') errors++;
    if (e.phase === 'checks') checks++;
    if (e.phase === 'revise') revisions++;
    phases[e.phase] = (phases[e.phase] || 0) + 1;
  }
  return { calls: evs.length, tokIn, tokOut, llmMs, errors, checks, revisions, phases };
}

async function processOne(plain, dt, plan, row) {
  const isCode = plan.bench === 'mbpp';
  const name = mbppName(row);
  let prompt = buildPrompt(row, plan.exact);
  if (isCode && name) prompt += `\n\nDefine it as a function named exactly \`${name}\` (same spelling and casing) and nothing else.`;
  const traceDir = path.join(RES, 'traces');

  // plain
  let plainA = '';
  let pSec = 0;
  let pOk = 0;
  let pVerify = { ok: false, reason: 'no run' };
  try {
    const t0 = Date.now();
    plainA = await chatPlain(plain, prompt);
    pSec = (Date.now() - t0) / 1000;
    pVerify = await verifyAnswer(plan, row, plainA);
    pOk = pVerify.ok ? 1 : 0;
  } catch (e) {
    plainA = `ERR: ${e.message}`;
    pVerify = { ok: false, reason: e.message };
  }

  // deepthink (with caller-owned trace — concurrent problems don't race)
  let dtA = '';
  let dSec = 0;
  let dOk = 0;
  let dVerify = { ok: false, reason: 'no run' };
  let tr = traceStats(null);
  try {
    const t0 = Date.now();
    const once = await runOnce(dt, prompt, isCode ? { answerFormat: undefined } : {});
    dtA = once.answer;
    dSec = (Date.now() - t0) / 1000;
    dVerify = await verifyAnswer(plan, row, dtA);
    dOk = dVerify.ok ? 1 : 0;
    tr = traceStats(once.trace);
    // persist the raw trace for offline reasoning-quality scoring
    if (once.trace && once.trace.size) {
      fs.mkdirSync(traceDir, { recursive: true });
      fs.writeFileSync(
        path.join(traceDir, `${plan.bench}_${row.id}.json`),
        JSON.stringify({ row: { id: row.id, problem: row.problem }, answer: dtA, trace: once.trace.toJSON() }, null, 2),
        'utf-8'
      );
    }
  } catch (e) {
    dtA = `ERR: ${e.message}`;
    dVerify = { ok: false, reason: e.message };
  }

  // self-correction only counts when a defect was found AND fixed:
  // a revision call implies a check failed; "revised & correct" is the win.
  const revised = tr.revisions > 0;
  const corrected = revised && dOk === 1;

  return { plainA, pSec, pOk, pVerify, dtA, dSec, dOk, dVerify, tr, revised, corrected };
}

function pct(n, d) {
  if (!d) return '0.0%';
  return ((100 * n) / d).toFixed(1) + '%';
}

function k(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function renderTable(perBench, coding, critique) {
  const lines = [];
  lines.push(`# Deepthink vs Plain Ollama — ${MODEL} (deepthink d=${DEPTH}, c=${CHECKS}, checks=${CHECK_STYLE}, verifier=${CRITIQUE_MODEL})`);
  lines.push('');
  lines.push('| Benchmark | n | Plain | Deepthink | Δ | dt calls (tok) | dt errors | self-corrected |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const b of perBench) {
    const p = pct(b.pOk, b.total);
    const d = pct(b.dOk, b.total);
    const delta = b.dOk - b.pOk;
    const sign = delta > 0 ? '+' : '';
    lines.push(`| ${b.label} | ${b.total} | ${p} | ${d} | ${sign}${delta} | ${b.dtCalls} (${k(b.dtTok)}) | ${b.dtErrors} | ${b.corrected}/${b.total} |`);
  }
  if (coding) {
    const p = critique?.scores?.plain?.parsed;
    const d = critique?.scores?.dt?.parsed;
    const ptot = p?.total ?? '?';
    const dtot = d?.total ?? '?';
    lines.push(`| Coding (critique) | 1 | total=${ptot}/50 | total=${dtot}/50 | ${dtot - ptot} | n/a | n/a | n/a |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runCoding(dt, plain, opts = {}) {
  console.log('\n== Coding benchmark ==');
  const specRow = JSON.parse(
    fs.readFileSync(path.join(DATA, 'coding.jsonl'), 'utf-8').split('\n').filter(Boolean)[0]
  );

  const plainPath = path.join(RES, 'coding', 'plain.html');
  const dtPath = path.join(RES, 'coding', 'dt.html');

  const HTML_SYS = 'You write production-grade, self-contained HTML. Output ONLY a code block containing the full HTML file. No commentary.';

  let plainHtml = '';
  let pSec = 0;
  if (fs.existsSync(plainPath) && opts.htmlOnly) {
    plainHtml = fs.readFileSync(plainPath, 'utf-8');
    console.log(`  plain HTML: ${plainHtml.length} chars (cached)`);
  } else {
    console.log('  generating plain HTML...');
    const t0 = Date.now();
    try {
      const r = await withRetry(
        () => plain.chat({
          model: MODEL,
          messages: [
            { role: 'system', content: HTML_SYS },
            { role: 'user', content: specRow.spec + '\n\nOutput ONLY the complete HTML file in one code block.' },
          ],
          stream: false,
        }),
        'coding.plain.chat'
      );
      plainHtml = (r && r.content) || '';
    } catch (e) {
      plainHtml = `ERR: ${e.message}`;
    }
    pSec = (Date.now() - t0) / 1000;
    fs.writeFileSync(plainPath, plainHtml, 'utf-8');
    console.log(`  plain HTML: ${plainHtml.length} chars, ${pSec.toFixed(1)}s`);
  }

  let dtHtml = '';
  let dSec = 0;
  let tr = traceStats(null);
  if (fs.existsSync(dtPath) && opts.htmlOnly) {
    dtHtml = fs.readFileSync(dtPath, 'utf-8');
    console.log(`  dt HTML: ${dtHtml.length} chars (cached)`);
  } else {
    console.log(`  generating deepthink HTML (d=${DEPTH} c=${CHECKS})...`);
    const t1 = Date.now();
    const myTrace = new TraceStore('flat', 500);
    try {
      const out = await withRetry(
        () => dt.generate(specRow.spec + '\n\nOutput ONLY the complete HTML file in one code block.', {
          depth: DEPTH,
          checks: CHECKS,
          checkStyle: CHECK_STYLE,
          systemPrompt: HTML_SYS,
          autoSystemPrompt: true,
          _trace: myTrace,
        }),
        'coding.dt.generate'
      );
      dtHtml = typeof out === 'string' ? out : (out && (out.answer || out.output || out.content || out.text || out.result)) || '';
    } catch (e) {
      dtHtml = `ERR: ${e.message}`;
    }
    dSec = (Date.now() - t1) / 1000;
    tr = traceStats(myTrace);
    if (myTrace.size) {
      const traceDir = path.join(RES, 'traces');
      fs.mkdirSync(traceDir, { recursive: true });
      fs.writeFileSync(path.join(traceDir, 'coding.json'), JSON.stringify({ answer: dtHtml, trace: myTrace.toJSON() }, null, 2), 'utf-8');
    }
    fs.writeFileSync(dtPath, dtHtml, 'utf-8');
    console.log(`  dt HTML: ${dtHtml.length} chars, ${dSec.toFixed(1)}s`);
  }

  // exactly 2 critique calls
  const cPath = path.join(RES, 'coding', 'critique.json');
  let critiqueData = null;
  if (opts.htmlOnly && fs.existsSync(cPath)) {
    console.log(`  critique: using cached ${cPath}`);
    critiqueData = JSON.parse(fs.readFileSync(cPath, 'utf-8'));
  } else {
    console.log(`  critiquing both with ${CRITIQUE_MODEL} (2 calls total)...`);
    const { spawnSync } = await import('node:child_process');
    const c = spawnSync('node', ['scripts/benchmarks/critique.js'], {
      encoding: 'utf-8',
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, BENCH_VERIFIER: CRITIQUE_MODEL },
    });
    if (c.status !== 0) {
      console.warn(`  critique failed: ${(c.stderr || '').slice(0, 200)}`);
    } else {
      process.stdout.write(c.stdout);
    }
    critiqueData = fs.existsSync(cPath) ? JSON.parse(fs.readFileSync(cPath, 'utf-8')) : null;
  }

  return {
    plain_bytes: plainHtml.length,
    dt_bytes: dtHtml.length,
    plain_seconds: pSec,
    dt_seconds: dSec,
    tr,
    critique: critiqueData,
  };
}

async function main() {
  console.log(`model:           ${MODEL}`);
  console.log(`verifier:        ${CRITIQUE_MODEL}`);
  console.log(`deepthink:       depth=${DEPTH} checks=${CHECKS}`);
  console.log(`concurrency:     ${CONCURRENCY}${FRESH ? ' (fresh)' : ''}`);
  console.log(`data dir:        ${DATA}`);
  console.log(`out dir:         ${RES}`);

  fs.mkdirSync(RES, { recursive: true });
  fs.mkdirSync(path.join(RES, 'coding'), { recursive: true });

  // CSV — resume-safe: read existing rows, append new ones, never overwrite.
  const csvPath = path.join(RES, 'all.csv');
  const done = new Set();
  let csvNeedsHeader = true;
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > 0 && lines[0].startsWith('bench,id,')) {
      csvNeedsHeader = false;
      for (const line of lines.slice(1)) {
        const cols = line.split(',');
        if (cols.length >= 2) done.add(`${cols[0]}|${cols[1]}`);
      }
    }
    console.log(`[resume] loaded ${done.size} completed rows from existing all.csv`);
  }
  if (FRESH) {
    done.clear();
    console.log('[fresh] ignoring completed rows');
  }
  const codingDone = [...done].some((k) => k.startsWith('coding|'));
  const codingHtmlDone =
    fs.existsSync(path.join(RES, 'coding', 'plain.html')) &&
    fs.existsSync(path.join(RES, 'coding', 'dt.html'));

  const csvFp = fs.openSync(csvPath, 'a');
  if (csvNeedsHeader) {
    fs.writeSync(
      csvFp,
      'bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,plain_codeexec_ok,dt_codeexec_ok,plain_s,dt_s,dt_calls,dt_tok_in,dt_tok_out,dt_llm_s,dt_errors,dt_checks,dt_revisions,dt_revised,dt_corrected\n'
    );
  }

  const dt = new Deepthink(MODEL, [], { provider: 'ollama' }, Infinity, CRITIQUE_MODEL, {
    adaptiveConcurrency: true,
    traceMode: 'flat',
  });
  const plain = dt.buildClient(null);

  const perBench = [];
  const queue = new PQueue({ concurrency: CONCURRENCY });

  for (const plan of BENCH_PLAN) {
    if (PLAN_FILTER.length && !PLAN_FILTER.includes(plan.bench)) continue;
    const items = loadBench(plan.file);
    const slice = plan.limit > 0 ? items.slice(0, plan.limit) : items;
    if (LIMIT > 0) slice.length = Math.min(slice.length, LIMIT);
    let pOk = 0, dOk = 0, pExec = 0, dExec = 0;
    let dtCalls = 0, dtTok = 0, dtErrors = 0, corrected = 0;
    let done2 = 0;
    console.log(`\n== ${plan.label} (${slice.length}/${items.length}) ==`);

    const todo = slice.filter((row) => !done.has(`${plan.bench}|${row.id}`));
    if (todo.length < slice.length) {
      // count already-done rows into the summary so percentages stay honest
      for (const row of slice) {
        const key = `${plan.bench}|${row.id}`;
        if (!done.has(key)) continue;
        const prev = fs.readFileSync(csvPath, 'utf-8').split('\n').find((l) => l.startsWith(`${plan.bench},${row.id},`));
        if (!prev) continue;
        const c = parseCsvLine(prev);
        if (c[4] === '1') pOk++;
        if (c[6] === '1') dOk++;
        if (c[7] === '1') pExec++;
        if (c[8] === '1') dExec++;
        dtCalls += Number(c[11]) || 0;
        dtTok += (Number(c[12]) || 0) + (Number(c[13]) || 0);
        if (c[19] === '1') corrected++;
        done2++;
      }
    }

    await queue.addAll(
      todo.map((row) => async () => {
        const key = `${plan.bench}|${row.id}`;
        done2++;
        const r = await processOne(plain, dt, plan, row);
        pOk += r.pOk;
        dOk += r.dOk;
        if (r.pVerify.ok) pExec++;
        if (r.dVerify.ok) dExec++;
        dtCalls += r.tr.calls;
        dtTok += r.tr.tokIn + r.tr.tokOut;
        dtErrors += r.tr.errors;
        if (r.corrected) corrected++;
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = `  [${stamp}] [${plan.bench} ${done2}/${slice.length}] plain ${r.pSec.toFixed(1)}s ${r.pOk ? 'OK' : 'X'} | dt ${r.dSec.toFixed(1)}s ${r.dOk ? 'OK' : 'X'} | exec plain=${r.pVerify.ok} dt=${r.dVerify.ok} | trace ${r.tr.calls} calls ${k(r.tr.tokIn + r.tr.tokOut)} tok ${r.tr.errors} err ${r.tr.revisions} rev${r.corrected ? ' ✓' : ''}`;
        console.log(line);
        try {
          fs.appendFileSync(path.join(RES, 'all.heartbeat.log'), line + '\n');
        } catch {}
        fs.writeSync(
          csvFp,
          [
            plan.bench,
            row.id,
            csvEscape(row.answer || ''),
            csvEscape(r.plainA),
            r.pOk,
            csvEscape(r.dtA),
            r.dOk,
            r.pVerify.ok ? 1 : 0,
            r.dVerify.ok ? 1 : 0,
            r.pSec.toFixed(1),
            r.dSec.toFixed(1),
            r.tr.calls,
            r.tr.tokIn,
            r.tr.tokOut,
            (r.tr.llmMs / 1000).toFixed(1),
            r.tr.errors,
            r.tr.checks,
            r.tr.revisions,
            r.revised ? 1 : 0,
            r.corrected ? 1 : 0,
          ].join(',') + '\n'
        );
        done.add(key);
      })
    );

    perBench.push({
      bench: plan.bench,
      label: plan.label,
      total: slice.length,
      pOk,
      dOk,
      pExecOk: pExec,
      dExecOk: dExec,
      dtCalls: Math.round(dtCalls / Math.max(1, slice.length)),
      dtTok: Math.round(dtTok / Math.max(1, slice.length)),
      dtErrors,
      corrected,
    });
  }

  fs.closeSync(csvFp);

  // coding + critique (skip if already done)
  let coding;
  if (codingDone && !FRESH) {
    console.log('\n== Coding benchmark == (skipped — already in CSV)');
    coding = { plain_bytes: 0, dt_bytes: 0, plain_seconds: 0, dt_seconds: 0, tr: traceStats(null), critique: null };
  } else if (codingHtmlDone && !FRESH) {
    console.log('\n== Coding benchmark == (HTML exists, but no CSV row — running critique only)');
    coding = await runCoding(dt, plain, { htmlOnly: true });
  } else {
    coding = await runCoding(dt, plain);
  }

  if (!codingDone || FRESH) {
    const csvPath2 = path.join(RES, 'all.csv');
    const c2 = fs.openSync(csvPath2, 'a');
    const cp = coding.critique?.scores?.plain?.parsed;
    const cd = coding.critique?.scores?.dt?.parsed;
    fs.writeSync(
      c2,
      [
        'coding',
        'gravity-sandbox',
        'N/A',
        csvEscape(`bytes=${coding.plain_bytes}`),
        'N/A',
        csvEscape(`bytes=${coding.dt_bytes}`),
        'N/A',
        'N/A',
        'N/A',
        coding.plain_seconds.toFixed(1),
        coding.dt_seconds.toFixed(1),
        coding.tr.calls,
        coding.tr.tokIn,
        coding.tr.tokOut,
        (coding.tr.llmMs / 1000).toFixed(1),
        coding.tr.errors,
        coding.tr.checks,
        coding.tr.revisions,
        'N/A',
        'N/A',
      ].join(',') + '\n'
    );
    fs.closeSync(c2);
  }

  // summary
  const summary = {
    model: MODEL,
    verifier_model: CRITIQUE_MODEL,
    depth: DEPTH,
    checks: CHECKS,
    rows: perBench,
    coding: {
      plain_bytes: coding.plain_bytes,
      dt_bytes: coding.dt_bytes,
      plain_seconds: coding.plain_seconds,
      dt_seconds: coding.dt_seconds,
      critique: coding.critique,
    },
  };
  fs.writeFileSync(path.join(RES, 'all.summary.json'), JSON.stringify(summary, null, 2));

  // table
  const table = renderTable(perBench, coding, coding.critique);
  fs.writeFileSync(path.join(RES, 'all.table.md'), table + '\n');
  console.log('\n' + table);
  console.log(`\nwrote ${csvPath}`);
  console.log(`wrote ${path.join(RES, 'all.summary.json')}`);
  console.log(`wrote ${path.join(RES, 'all.table.md')}`);
  if (dt._lastTrace) console.log(`concurrency level after run: ${dt.concurrencyScaler?.current ?? 'n/a'} (cached for next run)`);

  dt.destroy();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
