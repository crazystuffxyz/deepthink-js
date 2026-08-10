// scripts/benchmarks/freshRun.js
// plain vs deepthink on the FRESH untrained problem set (benchmarks/data/freshSet.jsonl).
// every problem is newly authored — not in any training data, not used to tune
// any prompt. this is the honest measurement of what deepthink adds.
//
// usage:
//   node scripts/benchmarks/freshRun.js [--model X] [--verifier Y] [--depth N]
//       [--checks N] [--limit N] [--plain-only] [--dt-only] [--concurrency N]
//
// output:
//   benchmarks/results/fresh.csv        (one row per problem per mode)
//   benchmarks/results/fresh.summary.json
//   benchmarks/results/fresh.table.md
//   benchmarks/results/traces/fresh-*.json
//
// resume-safe: problems already in fresh.csv are skipped.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQueue from 'p-queue';
import Deepthink, { TraceStore } from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const DATA = path.join(ROOT, 'data', 'freshSet.jsonl');
const RES = path.join(ROOT, 'results');
const TRACES = path.join(RES, 'traces');
fs.mkdirSync(RES, { recursive: true });
fs.mkdirSync(TRACES, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
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

// ---- answer parsing ----
// the model does not always obey "ANSWER: X" — it writes "answer is **Eating**",
// "Star is to **Galaxy**", "The next number is **Nine**". so parseAnswer
// returns a LIST of candidate answers (marker value, last number, short bolded
// segments, bracketed value) and answersMatch tries each against the gold.
const HEADER_RE = /^(by|recap|reasoning|explanation|analysis|conclusion|solution|answer|step|note|source|known|goal|constraint|reconstructed|diff|sanity|alternative|strategy|working|backward|structure|consolidated|response|approach|method|verification|check|final|wait|hmm|actually|first|second|third|addition|square|interleaved|remaining|give|eat)/i;
function parseAnswer(text) {
  const t = String(text || '').trim();
  const out = [];
  // 1. explicit markers: "ANSWER: X", "answer: X", "answer is X", "the answer is X"
  const m = t.match(/(?:ANSWER|answer)\s*:\s*([^\n]+)/i) || t.match(/(?:the\s+)?answer\s+is\s+([^\n.]+)/i);
  if (m) out.push(m[1].trim().replace(/\*\*/g, ''));
  // 2. last number
  const nums = t.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length) out.push(nums[nums.length - 1]);
  // 3. short bolded segments (not headers, no trailing colon), last first
  const bolds = t.match(/\*\*([^*]+)\*\*/g) || [];
  const cands = bolds.map((b) => b.replace(/\*\*/g, '').trim())
    .filter((c) => c && c.length <= 25 && !HEADER_RE.test(c) && !/:$/.test(c));
  for (const c of cands.reverse()) out.push(c);
  // 4. last bracketed value
  const b = t.match(/\[([^\]]+)\]\s*$/);
  if (b) out.push(b[1].trim());
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9./]/g, '').replace(/^0+(?=\d)/, '');
}

function isNumeric(s) {
  return s != null && /^-?\d+(\.\d+)?$/.test(String(s).trim());
}

// "$20,000" / "20,000" / "20 000" → 20000
function toNum(s) {
  const t = String(s).replace(/[$,\s%]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
}

function answersMatch(got, gold) {
  if (got == null || gold == null) return false;
  const g = String(gold).trim();
  const candidates = Array.isArray(got) ? got : [got];
  for (const a0 of candidates) {
    const a = String(a0).trim();
    if (a === '') continue; // empty answer must never match anything
    if (isNumeric(g)) {
      // numeric gold: exact or tolerance only — no substring games
      const an = toNum(a);
      if (isFinite(an)) {
        const gn = parseFloat(g);
        if (g.includes('.')) { if (Math.abs(gn - an) < 0.01) return true; }
        else if (gn === an) return true;
      }
      // semantic zero: "None." / "no change" for a 0 gold
      if (g === '0' && /^(none|zero|no change|nothing|same)$/i.test(a)) return true;
      continue;
    }
    // fraction gold: n/d vs decimal, percent, or \frac{n}{d}
    const gfrac = g.match(/^(\d+)\/(\d+)$/);
    if (gfrac) {
      const gd = parseInt(gfrac[1], 10) / parseInt(gfrac[2], 10);
      const af = a.match(/^(\d+)\/(\d+)$/);
      if (af) { if (Math.abs(parseInt(af[1], 10) / parseInt(af[2], 10) - gd) < 0.01) return true; continue; }
      const latex = a.match(/\\frac\{(\d+)\}\{(\d+)\}/);
      if (latex) { if (Math.abs(parseInt(latex[1], 10) / parseInt(latex[2], 10) - gd) < 0.01) return true; continue; }
      const pct = a.match(/^(\d+(?:\.\d+)?)%$/);
      if (pct) { if (Math.abs(parseFloat(pct[1], 10) / 100 - gd) < 0.01) return true; continue; }
      if (isNumeric(a)) { if (Math.abs(parseFloat(a) - gd) < 0.01) return true; continue; }
      continue;
    }
    if (norm(a) === norm(g) || norm(a).includes(norm(g)) || norm(g).includes(norm(a))) return true;
  }
  return false;
}

// ---- runners ----
const PLAIN_SYS = 'You are a precise problem solver. Solve the problem and give ONLY the answer, on a line that starts with "ANSWER: ". Do not include any other text after the answer line.';

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
  fs.writeFileSync(path.join(TRACES, `fresh-${item.id}.json`), JSON.stringify({ id: item.id, calls, tokens, ms: Date.now() - t0, phases, events: evs }, null, 2), 'utf-8');
  const parsed = parseAnswer(text);
  return { answer: parsed[0] ?? null, candidates: parsed, raw: text, ms: Date.now() - t0, tokens, calls, phases };
}

// ---- csv ----
const CSV = path.join(RES, 'fresh.csv');
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
    const out = { id: item.id, kind: item.kind, gold: item.answer };
    if (!PLAIN_ONLY && !done.has(item.id + '|plain')) {
      try {
        const p = await runPlain(dt, item);
        out.plain = p;
        out.plainOk = answersMatch(p.candidates ?? p.answer, item.answer);
        if (out.plainOk) plainOk++;
        plainN++;
        process.stdout.write(`[fresh] ${item.id} plain: ${out.plainOk ? 'OK' : 'X'} got=${p.answer} gold=${item.answer} (${p.ms}ms)\n`);
      } catch (e) {
        out.plain = { error: e.message };
        process.stdout.write(`[fresh] ${item.id} plain ERR: ${e.message}\n`);
      }
    }
    if (!DT_ONLY && !done.has(item.id + '|dt')) {
      try {
        const d = await runDeepThink(dt, item);
        out.dt = d;
        out.dtOk = answersMatch(d.candidates ?? d.answer, item.answer);
        if (out.dtOk) dtOk++;
        dtN++;
        process.stdout.write(`[fresh] ${item.id} dt: ${out.dtOk ? 'OK' : 'X'} got=${d.answer} gold=${item.answer} (${d.ms}ms, ${d.calls} calls, ${d.tokens} tok)\n`);
      } catch (e) {
        out.dt = { error: e.message };
        process.stdout.write(`[fresh] ${item.id} dt ERR: ${e.message}\n`);
      }
    }
    rows.push(out);
  }));

  await queue.onIdle();

  // write csv (append mode, resume-safe). error rows are NOT written so a
  // transient provider error retries on the next run.
  const lines = [csvHeader];
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
  fs.writeFileSync(path.join(RES, 'fresh.summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  // markdown table
  const kinds = [...new Set(allRows.map((r) => r.kind))];
  const md = ['# Fresh Set: plain vs deepthink', '', `model: ${MODEL} | verifier: ${CRITIQUE_MODEL} | depth ${DEPTH} checks ${CHECKS}`, '', '| kind | plain | dt | delta |', '|---|---|---|---|'];
  for (const k of kinds) {
    const pk = pRows.filter((r) => r.kind === k), dk = dRows.filter((r) => r.kind === k);
    const pn = pk.filter((r) => r.ok).length, dn = dk.filter((r) => r.ok).length;
    md.push(`| ${k} | ${pn}/${pk.length} | ${dn}/${dk.length} | ${dk.length ? '+' + (dn / dk.length * 100 - pn / Math.max(pk.length, 1) * 100).toFixed(0) : ''} |`);
  }
  md.push(`| **total** | **${pOk}/${pRows.length}** | **${dOk}/${dRows.length}** | **+${summary.delta}** |`);
  fs.writeFileSync(path.join(RES, 'fresh.table.md'), md.join('\n'), 'utf-8');

  console.log('\n' + md.join('\n'));
  console.log(`\n[fresh] plain ${pOk}/${pRows.length} (${summary.plain.pct}%) | dt ${dOk}/${dRows.length} (${summary.dt.pct}%) | delta +${summary.delta} pts`);
  console.log(`[fresh] saved ${CSV}`);
  process.exit(0);
})().catch((e) => { console.error('[fresh] fatal:', e); process.exit(1); });
