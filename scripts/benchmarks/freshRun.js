// scripts/benchmarks/freshRun.js
// plain vs deepthink on an untrained problem set (benchmarks/data/<set>.jsonl).
// every problem is newly authored — not in any training data, not used to tune
// any prompt. this is the honest measurement of what deepthink adds.
//
// usage:
//   node scripts/benchmarks/freshRun.js [--set freshSet|freshHard] [--model X]
//       [--verifier Y] [--depth N] [--checks N] [--limit N] [--plain-only]
//       [--dt-only] [--concurrency N]
//
// output:
//   benchmarks/results/<set>.csv        (one row per problem per mode)
//   benchmarks/results/<set>.summary.json
//   benchmarks/results/<set>.table.md
//   benchmarks/results/traces/<set>-*.json
//
// resume-safe: problems already in <set>.csv are skipped.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink, { TraceStore } from '../../dist/index.js';
import { parseAnswer, answersMatch } from './parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const RES = path.join(ROOT, 'results');
const TRACES = path.join(RES, 'traces');
fs.mkdirSync(RES, { recursive: true });
fs.mkdirSync(TRACES, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const SET = arg('set', 'freshSet');
const DATA = path.join(ROOT, 'data', SET + '.jsonl');
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const CRITIQUE_MODEL = arg('verifier', process.env.BENCH_VERIFIER || 'deepseek-v4-flash:0731-cloud');
const DEPTH = Number(arg('depth', process.env.BENCH_DEPTH || '2'));
const CHECKS = Number(arg('checks', process.env.BENCH_CHECKS || '1'));
const LIMIT = Number(arg('limit', '0'));
const CONCURRENCY = Number(arg('concurrency', process.env.BENCH_CONCURRENCY || '2'));
const PLAIN_ONLY = process.argv.includes('--plain-only');
const DT_ONLY = process.argv.includes('--dt-only');

const problems = fs.readFileSync(DATA, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const selected = LIMIT > 0 ? problems.slice(0, LIMIT) : problems;

// ---- runners ----
// if the problem lists numbered choices, the answer must be the choice
// NUMBER only — models otherwise answer the value ("10") instead of the
// index ("3"), which no parser can disambiguate
const PLAIN_SYS = 'You are a precise problem solver. Solve the problem and give ONLY the answer, on a line that starts with "ANSWER: ". If the problem lists numbered choices, answer with the choice number only (e.g. "ANSWER: 3"). Do not include any other text after the answer line.';

async function runPlain(dt, item) {
  const t0 = Date.now();
  const r = await dt.callChat(
    [{ role: 'system', content: PLAIN_SYS }, { role: 'user', content: item.prompt }],
    false, null,
    { think: false, autoSystemPrompt: false, temperature: 0.2 }
  );
  const parsed = parseAnswer(r.content);
  return { answer: parsed[0] ?? null, candidates: parsed, raw: r.content, ms: Date.now() - t0, tokens: r.usage?.total_tokens ?? 0 };
}

async function runDeepThink(dt, item) {
  const trace = new TraceStore('flat', 500);
  const t0 = Date.now();
  const r = await dt.generate(item.prompt, {
    depth: DEPTH, checks: CHECKS, enableCode: false, _trace: trace,
    systemPrompt: PLAIN_SYS,
  });
  const text = typeof r === 'object' && r !== null ? JSON.stringify(r) : String(r);
  const evs = trace.toJSON();
  const tokens = evs.reduce((a, e) => a + (e.promptTokens || 0) + (e.responseTokens || 0), 0);
  const calls = evs.length;
  const phases = {};
  for (const e of evs) phases[e.phase] = (phases[e.phase] || 0) + 1;
  fs.writeFileSync(path.join(TRACES, `${SET}-${item.id}.json`), JSON.stringify({ id: item.id, calls, tokens, ms: Date.now() - t0, phases, events: evs }, null, 2), 'utf-8');
  const parsed = parseAnswer(text);
  return { answer: parsed[0] ?? null, candidates: parsed, raw: text, ms: Date.now() - t0, tokens, calls, phases };
}

// ---- csv ----
const CSV = path.join(RES, SET + '.csv');
const csvHeader = 'id,kind,mode,answer,gold,ok,ms,tokens,calls,raw';
function csvEscape(s) {
  const t = String(s ?? '').replace(/\r?\n/g, ' ').slice(0, 2000);
  return t.includes(',') || t.includes('"') ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function loadDone() {
  if (!fs.existsSync(CSV)) return new Set();
  return new Set(fs.readFileSync(CSV, 'utf-8').split('\n').slice(1).filter(Boolean).map((l) => l.split(',')[0] + '|' + l.split(',')[2]));
}

(async () => {
  const done = loadDone();
  const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
  const queue = new PQueue({ concurrency: CONCURRENCY });
  const rows = [];
  let plainOk = 0, dtOk = 0, plainN = 0, dtN = 0;

  const tasks = selected.map((item) => queue.add(async () => {
    const out = { id: item.id, kind: item.kind, gold: item.reference ?? item.answer };
    if (!PLAIN_ONLY && !done.has(item.id + '|plain')) {
      try {
        const p = await runPlain(dt, item);
        out.plain = p;
        out.plainOk = answersMatch(p.candidates ?? p.answer, item.reference ?? item.answer);
        if (out.plainOk) plainOk++;
        plainN++;
        process.stdout.write(`[${SET}] ${item.id} plain: ${out.plainOk ? 'OK' : 'X'} got=${p.answer} gold=${item.reference ?? item.answer} (${p.ms}ms)\n`);
      } catch (e) {
        out.plain = { error: e.message };
        process.stdout.write(`[${SET}] ${item.id} plain ERR: ${e.message}\n`);
      }
    }
    if (!DT_ONLY && !done.has(item.id + '|dt')) {
      try {
        const d = await runDeepThink(dt, item);
        out.dt = d;
        out.dtOk = answersMatch(d.candidates ?? d.answer, item.reference ?? item.answer);
        if (out.dtOk) dtOk++;
        dtN++;
        process.stdout.write(`[${SET}] ${item.id} dt: ${out.dtOk ? 'OK' : 'X'} got=${d.answer} gold=${item.reference ?? item.answer} (${d.ms}ms, ${d.calls} calls, ${d.tokens} tok)\n`);
      } catch (e) {
        out.dt = { error: e.message };
        process.stdout.write(`[${SET}] ${item.id} dt ERR: ${e.message}\n`);
      }
    }
    rows.push(out);
  }));

  await queue.onIdle();

  // write csv (append mode, resume-safe). error rows are NOT written so a
  // transient provider error retries on the next run. header only when the
  // file is new — a re-run appends rows to an existing header, and a second
  // header line would be parsed as a bogus data row (kind="kind").
  const lines = fs.existsSync(CSV) && fs.readFileSync(CSV, 'utf-8').trim() ? [] : [csvHeader];
  for (const r of rows) {
    if (r.plain && !r.plain.error && !done.has(r.id + '|plain')) lines.push([r.id, r.kind, 'plain', csvEscape(r.plain.answer), csvEscape(r.gold), r.plainOk ? 1 : 0, r.plain.ms, r.plain.tokens, r.plain.calls ?? 1, csvEscape(r.plain.raw)].join(','));
    if (r.dt && !r.dt.error && !done.has(r.id + '|dt')) lines.push([r.id, r.kind, 'dt', csvEscape(r.dt.answer), csvEscape(r.gold), r.dtOk ? 1 : 0, r.dt.ms, r.dt.tokens, r.dt.calls ?? 1, csvEscape(r.dt.raw)].join(','));
  }
  fs.appendFileSync(CSV, lines.join('\n') + '\n', 'utf-8');

  // summary from full csv (all completed rows)
  const allRows = fs.readFileSync(CSV, 'utf-8').split('\n').slice(1).filter(Boolean).map((l) => {
    const c = l.split(',');
    return { id: c[0], kind: c[1], mode: c[2], ok: c[5] === '1' };
  });
  const byMode = (m) => allRows.filter((r) => r.mode === m);
  const pRows = byMode('plain'), dRows = byMode('dt');
  const pOk = pRows.filter((r) => r.ok).length, dOk = dRows.filter((r) => r.ok).length;
  const summary = {
    model: MODEL, verifier: CRITIQUE_MODEL, depth: DEPTH, checks: CHECKS,
    date: new Date().toISOString(),
    plain: { n: pRows.length, correct: pOk, pct: pRows.length ? +(pOk / pRows.length * 100).toFixed(1) : 0 },
    dt: { n: dRows.length, correct: dOk, pct: dRows.length ? +(dOk / dRows.length * 100).toFixed(1) : 0 },
    delta: dRows.length && pRows.length ? +(dOk / dRows.length * 100 - pOk / pRows.length * 100).toFixed(1) : 0,
  };
  fs.writeFileSync(path.join(RES, SET + '.summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  // markdown table
  const kinds = [...new Set(allRows.map((r) => r.kind))];
  const md = ['# Fresh Set: plain vs deepthink', '', `model: ${MODEL} | verifier: ${CRITIQUE_MODEL} | depth ${DEPTH} checks ${CHECKS}`, '', '| kind | plain | dt | delta |', '|---|---|---|---|'];
  for (const k of kinds) {
    const pk = pRows.filter((r) => r.kind === k), dk = dRows.filter((r) => r.kind === k);
    const pn = pk.filter((r) => r.ok).length, dn = dk.filter((r) => r.ok).length;
    md.push(`| ${k} | ${pn}/${pk.length} | ${dn}/${dk.length} | ${dk.length ? '+' + (dn / dk.length * 100 - pn / Math.max(pk.length, 1) * 100).toFixed(0) : ''} |`);
  }
  md.push(`| **total** | **${pOk}/${pRows.length}** | **${dOk}/${dRows.length}** | **+${summary.delta}** |`);
  fs.writeFileSync(path.join(RES, SET + '.table.md'), md.join('\n'), 'utf-8');

  console.log('\n' + md.join('\n'));
  console.log(`\n[${SET}] plain ${pOk}/${pRows.length} (${summary.plain.pct}%) | dt ${dOk}/${dRows.length} (${summary.dt.pct}%) | delta +${summary.delta} pts`);
  console.log(`[${SET}] saved ${CSV}`);
  process.exit(0);
})().catch((e) => { console.error('[${SET}] fatal:', e); process.exit(1); });
