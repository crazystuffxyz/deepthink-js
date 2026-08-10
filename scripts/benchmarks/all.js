// scripts/benchmarks/all.js
// the master orchestrator. runs every benchmark and prints a single
// comparison table.
//
//   - AIME 2024-I + 2024-II (integer answers, sympy-checked)
//   - USAMO 2024 (3 numeric + 3 proof)
//   - IMO 2024 (all proof; keyword-gate verifier)
//   - Integration Bee (1 definite + 1 indefinite, sympy)
//   - Coding (single HTML, plain ollama vs deepthink d=3 c=2,
//     critiqued by minimax-m3:cloud — exactly 2 calls)
//
// output:
//   benchmarks/results/all.csv
//   benchmarks/results/all.summary.json
//   benchmarks/results/all.table.md
//   console: a single markdown table
//
// all.js exits 0 even on benchmark errors — it just records them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../../dist/index.js';
import { verify } from './verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const DATA = path.join(ROOT, 'data');
const RES = path.join(ROOT, 'results');
const MODEL = 'minimax-m3:cloud';
const CRITIQUE_MODEL = 'gemma4:31b-cloud';
const DEPTH = 2;
const CHECKS = 2;

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
];

function loadBench(name) {
  // accept both with and without .jsonl extension
  const fn = name.endsWith('.jsonl') ? name : name + '.jsonl';
  const fp = path.join(DATA, fn);
  if (!fs.existsSync(fp)) throw new Error(`missing ${fp}`);
  return fs
    .readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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

// retry wrapper: ollama `fetch failed` errors are transient. 3 attempts,
// exponential backoff, and a hard per-call timeout so a hung connection
// can't kill the entire run. on success returns the value; on final
// failure throws.
async function withTimeout(fn, ms) {
  return await Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
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

async function runOnce(dt, prompt) {
  const r = await withRetry(
    () => dt.generate(prompt, { depth: DEPTH, checks: CHECKS }),
    'dt.generate'
  );
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    return r.answer || r.output || r.content || r.text || r.result || JSON.stringify(r);
  }
  return String(r);
}

async function processOne(plain, dt, plan, row) {
  const prompt = buildPrompt(row, plan.exact);

  // plain
  let plainA = '';
  let pSec = 0;
  let pOk = 0;
  let pVerify = { ok: false, reason: 'no run' };
  try {
    const t0 = Date.now();
    plainA = await chatPlain(plain, prompt);
    pSec = (Date.now() - t0) / 1000;
    pVerify = verify({ row, modelText: plainA });
    pOk = pVerify.ok ? 1 : 0;
  } catch (e) {
    plainA = `ERR: ${e.message}`;
    pVerify = { ok: false, reason: e.message };
  }

  // deepthink
  let dtA = '';
  let dSec = 0;
  let dOk = 0;
  let dVerify = { ok: false, reason: 'no run' };
  try {
    const t0 = Date.now();
    dtA = await runOnce(dt, prompt);
    dSec = (Date.now() - t0) / 1000;
    dVerify = verify({ row, modelText: dtA });
    dOk = dVerify.ok ? 1 : 0;
  } catch (e) {
    dtA = `ERR: ${e.message}`;
    dVerify = { ok: false, reason: e.message };
  }

  return { plainA, pSec, pOk, pVerify, dtA, dSec, dOk, dVerify };
}

function pct(n, d) {
  if (!d) return '0.0%';
  return ((100 * n) / d).toFixed(1) + '%';
}

function renderTable(perBench, coding, critique) {
  const lines = [];
  lines.push(`# Deepthink vs Plain Ollama — ${MODEL} (deepthink d=${DEPTH}, c=${CHECKS})`);
  lines.push('');
  lines.push(`> sympy-backed code-execution verification on every math row. critique by \`${CRITIQUE_MODEL}\` (2 calls total, one per HTML).`);
  lines.push('');
  lines.push('| Benchmark | n | Plain ollama | Deepthink | Δ (dt - plain) | Code-exec agreement |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const b of perBench) {
    const p = pct(b.pOk, b.total);
    const d = pct(b.dOk, b.total);
    const delta = b.dOk - b.pOk;
    const sign = delta > 0 ? '+' : '';
    const ex = `${b.pExecOk}/${b.total} vs ${b.dExecOk}/${b.total}`;
    lines.push(`| ${b.label} | ${b.total} | ${p} | ${d} | ${sign}${delta} | ${ex} |`);
  }
  if (coding) {
    const p = critique?.scores?.plain?.parsed;
    const d = critique?.scores?.dt?.parsed;
    const ptot = p?.total ?? '?';
    const dtot = d?.total ?? '?';
    lines.push(`| Coding (critique) | 1 | total=${ptot}/50 | total=${dtot}/50 | ${dtot - ptot} | n/a |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runCoding(dt, plain, opts = {}) {
  console.log('\n== Coding benchmark ==');
  // the spec is in coding.jsonl — we read it so the prompt is
  // exactly the same for plain and dt.
  const specRow = JSON.parse(
    fs.readFileSync(path.join(DATA, 'coding.jsonl'), 'utf-8').split('\n').filter(Boolean)[0]
  );

  const plainPath = path.join(RES, 'coding', 'plain.html');
  const dtPath = path.join(RES, 'coding', 'dt.html');

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
            { role: 'system', content: 'You write production-grade, self-contained HTML. Output ONLY a code block containing the full HTML file. No commentary.' },
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
  if (fs.existsSync(dtPath) && opts.htmlOnly) {
    dtHtml = fs.readFileSync(dtPath, 'utf-8');
    console.log(`  dt HTML: ${dtHtml.length} chars (cached)`);
  } else {
    console.log(`  generating deepthink HTML (d=${DEPTH} c=${CHECKS})...`);
    const t1 = Date.now();
    try {
      const out = await withRetry(
        () => dt.generate(
          specRow.spec + '\n\nOutput ONLY the complete HTML file in one code block.',
          { depth: DEPTH, checks: CHECKS, system: 'You write production-grade, self-contained HTML. Output ONLY a code block containing the full HTML file. No commentary.' }
        ),
        'coding.dt.generate'
      );
      dtHtml = typeof out === 'string' ? out : (out && (out.answer || out.output || out.content || out.text || out.result)) || '';
    } catch (e) {
      dtHtml = `ERR: ${e.message}`;
    }
    dSec = (Date.now() - t1) / 1000;
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
    critique: critiqueData,
  };
}

async function main() {
  console.log(`model:           ${MODEL}`);
  console.log(`critique model:  ${CRITIQUE_MODEL}`);
  console.log(`deepthink:       depth=${DEPTH} checks=${CHECKS}`);
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
  // mark coding as done if its csv row already exists
  const codingDone = [...done].some((k) => k.startsWith('coding|'));
  const codingHtmlDone =
    fs.existsSync(path.join(RES, 'coding', 'plain.html')) &&
    fs.existsSync(path.join(RES, 'coding', 'dt.html'));

  const csvFp = fs.openSync(csvPath, 'a');
  if (csvNeedsHeader) {
    fs.writeSync(
      csvFp,
      'bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,plain_codeexec_ok,dt_codeexec_ok,plain_s,dt_s\n'
    );
  }

  const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
  const plain = dt.buildClient(null);

  const perBench = [];

  for (const plan of BENCH_PLAN) {
    const items = loadBench(plan.file);
    const slice = plan.limit > 0 ? items.slice(0, plan.limit) : items;
    let pOk = 0, dOk = 0, pExec = 0, dExec = 0;
    console.log(`\n== ${plan.label} (${slice.length}/${items.length}) ==`);
    let done2 = 0;
    for (const row of slice) {
      const key = `${plan.bench}|${row.id}`;
      done2++;
      if (done.has(key)) {
        console.log(`  [${plan.bench} ${done2}/${slice.length}] SKIP (already done)`);
        continue;
      }
      const r = await processOne(plain, dt, plan, row);
      pOk += r.pOk;
      dOk += r.dOk;
      if (r.pVerify.ok) pExec++;
      if (r.dVerify.ok) dExec++;
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const line = `  [${stamp}] [${plan.bench} ${done2}/${slice.length}] plain ${r.pSec.toFixed(1)}s ${r.pOk ? 'OK' : 'X'} | dt ${r.dSec.toFixed(1)}s ${r.dOk ? 'OK' : 'X'} | exec plain=${r.pVerify.ok} dt=${r.dVerify.ok}`;
      console.log(line);
      // also append a heartbeat to a separate log so progress survives stdout buffering
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
        ].join(',') + '\n'
      );
      done.add(key);
    }
    perBench.push({
      bench: plan.bench,
      label: plan.label,
      total: slice.length,
      pOk,
      dOk,
      pExecOk: pExec,
      dExecOk: dExec,
    });
  }

  fs.closeSync(csvFp);

  // coding + critique (skip if already done)
  let coding;
  if (codingDone) {
    console.log('\n== Coding benchmark == (skipped — already in CSV)');
    coding = { plain_bytes: 0, dt_bytes: 0, plain_seconds: 0, dt_seconds: 0, critique: null };
  } else if (codingHtmlDone) {
    console.log('\n== Coding benchmark == (HTML exists, but no CSV row — running critique only)');
    coding = await runCoding(dt, plain, { htmlOnly: true });
  } else {
    coding = await runCoding(dt, plain);
  }

  // append coding row only if not already present
  if (!codingDone) {
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
      ].join(',') + '\n'
    );
    fs.closeSync(c2);
  }

  // summary
  const summary = {
    model: MODEL,
    critique_model: CRITIQUE_MODEL,
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

  dt.destroy();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
