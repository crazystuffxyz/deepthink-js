// scripts/benchmarks/checkModes.js
// self-correction architecture experiment. same problems, same model, same
// think pipeline (depth 2) — only the CHECK MODE changes:
//
//   full  — checkers audit the whole draft (QA + Adversarial + Numerical)
//   blind — checkers see ONLY the claimed answer and must re-derive it
//   zero  — no checks at all
//
// answers: does verifier-blind verification beat draft-auditing? do checks
// pay for themselves vs zero? measured on correctness, calls, tokens, wall
// time, and convergence (revisions).
//
// usage:
//   node scripts/benchmarks/checkModes.js [--model X] [--verifier Y] [--limit N]
//
// output:
//   benchmarks/results/checkModes.json
//   benchmarks/results/checkModes.md

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink, { TraceStore } from '../../dist/index.js';
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
const LIMIT = Number(arg('limit', '0'));
const DEPTH = 2;

const MODES = [
  { name: 'full', checks: 2, checkStyle: 'full' },
  { name: 'blind', checks: 2, checkStyle: 'blind' },
  { name: 'zero', checks: 0, checkStyle: 'full' },
];

function loadBench(name) {
  const fp = path.join(DATA, name + '.jsonl');
  return fs
    .readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function withTimeout(fn, ms) {
  return await Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function withRetry(fn, label = 'dt.generate', attempts = 5, timeoutMs = 15 * 60_000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (e) {
      lastErr = e;
      const wait = 1000 * Math.pow(2, i);
      console.log(`    [retry ${i + 1}/${attempts}] ${label}: ${e.message?.slice(0, 80) || e}. wait ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function traceStats(store) {
  if (!store || !store.size) return { calls: 0, tokIn: 0, tokOut: 0, llmMs: 0, errors: 0, checks: 0, revisions: 0 };
  let tokIn = 0, tokOut = 0, llmMs = 0, errors = 0, checks = 0, revisions = 0;
  const evs = store.events;
  for (const e of evs) {
    tokIn += e.promptTokens || 0;
    tokOut += e.responseTokens || 0;
    llmMs += e.latencyMs || 0;
    if (e.status === 'error') errors++;
    if (e.phase === 'checks') checks++;
    if (e.phase === 'revise') revisions++;
  }
  return { calls: evs.length, tokIn, tokOut, llmMs, errors, checks, revisions };
}

async function runOnce(dt, prompt, mode) {
  const myTrace = new TraceStore('flat', 500);
  const r = await withRetry(() => dt.generate(prompt, { depth: DEPTH, checks: mode.checks, checkStyle: mode.checkStyle, answerFormat: 'bracket', _trace: myTrace }), `dt.generate(${mode.name})`);
  const answer = typeof r === 'string' ? r : (r && typeof r === 'object') ? (r.answer || r.output || r.content || r.text || r.result || JSON.stringify(r)) : String(r);
  return { answer, trace: myTrace };
}

async function main() {
  fs.mkdirSync(RES, { recursive: true });
  const problems = [...loadBench('aime-2024-I'), ...loadBench('aime-2024-II')].filter((r) => r.kind === 'math-aime');
  const rows = LIMIT > 0 ? problems.slice(0, LIMIT) : problems;
  console.log(`checkModes: model=${MODEL} verifier=${CRITIQUE_MODEL} depth=${DEPTH} problems=${rows.length}`);
  console.log(`modes: ${MODES.map((m) => m.name).join(' / ')}\n`);

  const dt = new Deepthink(MODEL, [], {}, 1, CRITIQUE_MODEL);
  const out = { meta: { model: MODEL, verifier: CRITIQUE_MODEL, depth: DEPTH, ts: new Date().toISOString() }, modes: {} };

  for (const mode of MODES) {
    console.log(`=== mode: ${mode.name} (checks=${mode.checks}, style=${mode.checkStyle}) ===`);
    const runs = [];
    for (const row of rows) {
      const t0 = Date.now();
      let answer = '', sec = 0, ok = 0, reason = 'no run';
      let tr = traceStats(null);
      try {
        const once = await runOnce(dt, row.problem, mode);
        answer = once.answer;
        sec = (Date.now() - t0) / 1000;
        const v = verify({ row, modelText: answer });
        ok = v.ok ? 1 : 0;
        reason = v.reason;
        tr = traceStats(once.trace);
      } catch (e) {
        answer = `ERR: ${e.message}`;
        sec = (Date.now() - t0) / 1000;
        reason = e.message;
      }
      const line = `  [${row.id}] ${ok ? 'OK' : 'X '} ${sec.toFixed(1)}s | ${tr.calls} calls ${(tr.tokIn + tr.tokOut) / 1000 | 0}k tok ${tr.revisions} rev | ${reason.slice(0, 60)}`;
      console.log(line);
      runs.push({ id: row.id, ok, sec, reason, ...tr });
    }
    const agg = runs.reduce(
      (a, r) => ({
        correct: a.correct + r.ok,
        total: a.total + 1,
        calls: a.calls + r.calls,
        tokIn: a.tokIn + r.tokIn,
        tokOut: a.tokOut + r.tokOut,
        llmMs: a.llmMs + r.llmMs,
        sec: a.sec + r.sec,
        checks: a.checks + r.checks,
        revisions: a.revisions + r.revisions,
      }),
      { correct: 0, total: 0, calls: 0, tokIn: 0, tokOut: 0, llmMs: 0, sec: 0, checks: 0, revisions: 0 }
    );
    out.modes[mode.name] = { runs, agg };
    console.log(`  => ${agg.correct}/${agg.total} correct | ${(agg.sec / agg.total).toFixed(0)}s avg | ${(agg.calls / agg.total).toFixed(1)} calls avg | ${((agg.tokIn + agg.tokOut) / agg.total / 1000 | 0)}k tok avg | ${agg.revisions} revisions total\n`);
  }
  dt.destroy();

  // markdown table
  const md = [];
  md.push(`# Check-mode experiment — ${MODEL} (verifier ${CRITIQUE_MODEL}, depth ${DEPTH})`);
  md.push('');
  md.push('| mode | correct | avg s | avg calls | avg k-tok | llm s | checks | revisions |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const m of MODES) {
    const a = out.modes[m.name].agg;
    md.push(`| ${m.name} | ${a.correct}/${a.total} | ${(a.sec / a.total).toFixed(0)} | ${(a.calls / a.total).toFixed(1)} | ${((a.tokIn + a.tokOut) / a.total / 1000 | 0)} | ${(a.llmMs / 1000 | 0)} | ${a.checks} | ${a.revisions} |`);
  }
  fs.writeFileSync(path.join(RES, 'checkModes.json'), JSON.stringify(out, null, 2), 'utf-8');
  fs.writeFileSync(path.join(RES, 'checkModes.md'), md.join('\n'), 'utf-8');
  console.log(md.join('\n'));
}

main().catch((e) => {
  console.error('checkModes failed:', e);
  process.exit(1);
});
