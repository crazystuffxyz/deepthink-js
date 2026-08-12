// scripts/benchmarks/codingRun.js
// plain vs deepthink on fresh HTML-coding specs (benchmarks/data/<set>.jsonl).
// each spec: plain gemma writes the HTML, deepthink (d=3 c=2) writes it too;
// a blind 5-axis judge scores both files. pass = total ≥ 42/50 AND every
// axis ≥ 6 (ruthless but fair).
//
// usage:
//   node scripts/benchmarks/codingRun.js [--set coding2] [--model X] [--verifier Y]
//       [--depth N] [--checks N] [--limit N] [--plain-only] [--dt-only]
//
// output:
//   benchmarks/results/<set>.csv
//   benchmarks/results/<set>.summary.json
//   benchmarks/results/<set>.table.md
//   benchmarks/results/codinggen/<set>-<id>-<mode>.html
//
// resume-safe: ids already in <set>.csv are skipped.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', 'benchmarks');
const RES = path.join(ROOT, 'results');
const FILES = path.join(RES, 'codinggen');
fs.mkdirSync(FILES, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const SET = arg('set', 'coding2');
const DATA = path.join(ROOT, 'data', SET + '.jsonl');
const MODEL = arg('model', process.env.BENCH_MODEL || 'gemma4:31b-cloud');
const CRITIQUE_MODEL = arg('verifier', process.env.BENCH_VERIFIER || 'deepseek-v4-flash:0731-cloud');
const DEPTH = Number(arg('depth', '3'));
const CHECKS = Number(arg('checks', '2'));
const LIMIT = Number(arg('limit', '0'));
const PLAIN_ONLY = process.argv.includes('--plain-only');
const DT_ONLY = process.argv.includes('--dt-only');

const specs = fs.readFileSync(DATA, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const selected = LIMIT > 0 ? specs.slice(0, LIMIT) : specs;

// ---- generation ----
const SYS = `You are a senior frontend engineer. You write production-grade, self-contained HTML. You respond with exactly one file wrapped in a sentinel block. NEVER use placeholders, "..." or "rest of code here". NEVER include external network calls. NEVER use <script src=...> with a remote URL. The HTML must be openable by double-clicking the file.

Output format (NO prose, NO markdown fences, NO commentary):

=== FILE: index.html ===
<!doctype html>
<html>
... complete file ...
</html>
=== END ===
`;

const userPrompt = (specText) => `Implement this specification as a single self-contained HTML file:

${specText}

Wrap the complete file in the sentinel block as shown in the system instructions. Do not add anything before or after the block. Do not include explanations.`;

function extractHtml(text) {
  if (!text) return '';
  const m = String(text).match(/===\s*FILE:\s*index\.html\s*===\s*([\s\S]*?)\s*===\s*END\s*===/i);
  if (m) return m[1].trim();
  const fb = String(text).match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fb) return fb[1].trim();
  const dt = String(text).match(/<!doctype[\s\S]*?<\/html>/i);
  if (dt) return dt[0];
  return String(text).trim();
}

async function runPlain(dt, spec) {
  const t0 = Date.now();
  const r = await dt.callChat(
    [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt(spec.spec) }],
    false, null, { think: false, autoSystemPrompt: false, temperature: 0.2 }
  );
  return { html: extractHtml(r.content), ms: Date.now() - t0, tokens: r.usage?.total_tokens ?? 0 };
}

async function runDeepThink(dt, spec) {
  const t0 = Date.now();
  const out = await dt.generate(userPrompt(spec.spec), {
    depth: DEPTH, checks: CHECKS, systemPrompt: SYS,
  });
  const text = typeof out === 'string' ? out : (out && (out.answer || out.output || out.content || out.text || out.result)) || '';
  return { html: extractHtml(text), ms: Date.now() - t0, tokens: 0 };
}

// ---- critique ----
const JUDGE_SYS = `You are a strict senior frontend reviewer. You are given a single self-contained HTML file. You score it on 5 axes from 1 to 10 each, integer only. Be ruthless but fair.

Axes:
  correctness    - does it actually implement the spec? does the JS work?
  completeness   - does it cover every numbered requirement?
  code_quality   - structure, naming, no dead code, no eval, sane globals
  ux             - controls, feedback, default state, visual polish
  perf           - reasonable 60fps loop, no leaks, no allocation in hot path

Reply with ONLY a JSON object, no markdown fences, no prose:
{"correctness":N,"completeness":N,"code_quality":N,"ux":N,"perf":N,"total":N,"notes":"one or two sentences"}`;

const judgeUser = (spec, html) => `Spec id: ${spec.id}

File contents (size=${html.length} chars):
\`\`\`html
${html.slice(0, 60_000)}
\`\`\`

Score the file. JSON only.`;

function extractJson(text) {
  if (!text) return null;
  const t = String(text);
  const fb = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fb ? fb[1] : t;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function critique(dt, spec, html, mode) {
  const t0 = Date.now();
  const r = await dt.callChat(
    [{ role: 'system', content: JUDGE_SYS }, { role: 'user', content: judgeUser(spec, html) }],
    false, null, { think: false, autoSystemPrompt: false, temperature: 0.1, options: { num_predict: 400 } }
  );
  const j = extractJson(r.content);
  if (!j) return { mode, error: 'unparseable critique', ms: Date.now() - t0 };
  const axes = ['correctness', 'completeness', 'code_quality', 'ux', 'perf'];
  const vals = axes.map((a) => Math.round(Number(j[a]) || 0));
  const total = Math.round(Number(j.total) || vals.reduce((x, y) => x + y, 0));
  const minAxis = Math.min(...vals);
  return { mode, total, axes: vals, minAxis, pass: total >= 42 && minAxis >= 6, notes: String(j.notes || ''), ms: Date.now() - t0 };
}

// ---- csv ----
const CSV = path.join(RES, SET + '.csv');
const csvHeader = 'id,mode,pass,total,min_axis,correctness,completeness,code_quality,ux,perf,html_chars,ms,notes';
function csvEscape(s) {
  const t = String(s ?? '').replace(/\r?\n/g, ' ').slice(0, 500);
  return t.includes(',') || t.includes('"') ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function loadDone() {
  if (!fs.existsSync(CSV)) return new Set();
  return new Set(fs.readFileSync(CSV, 'utf-8').split('\n').slice(1).filter(Boolean).map((l) => l.split(',')[0] + '|' + l.split(',')[1]));
}

(async () => {
  const done = loadDone();
  const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
  const rows = [];
  let plainOk = 0, dtOk = 0, plainN = 0, dtN = 0;

  for (const spec of selected) {
    const out = { id: spec.id };
    if (!PLAIN_ONLY && !done.has(spec.id + '|plain')) {
      try {
        const p = await runPlain(dt, spec);
        fs.writeFileSync(path.join(FILES, `${SET}-${spec.id}-plain.html`), p.html, 'utf-8');
        const c = await critique(dt, spec, p.html, 'plain');
        out.plain = { ...p, ...c };
        if (c.pass) plainOk++;
        plainN++;
        process.stdout.write(`[${SET}] ${spec.id} plain: ${c.pass ? 'PASS' : 'FAIL'} total=${c.total} min=${c.minAxis} (${Math.round(c.ms / 1000)}s)\n`);
      } catch (e) {
        out.plain = { error: e.message };
        process.stdout.write(`[${SET}] ${spec.id} plain ERR: ${e.message}\n`);
      }
    }
    if (!DT_ONLY && !done.has(spec.id + '|dt')) {
      try {
        const d = await runDeepThink(dt, spec);
        fs.writeFileSync(path.join(FILES, `${SET}-${spec.id}-dt.html`), d.html, 'utf-8');
        const c = await critique(dt, spec, d.html, 'dt');
        out.dt = { ...d, ...c };
        if (c.pass) dtOk++;
        dtN++;
        process.stdout.write(`[${SET}] ${spec.id} dt: ${c.pass ? 'PASS' : 'FAIL'} total=${c.total} min=${c.minAxis} (${Math.round(c.ms / 1000)}s)\n`);
      } catch (e) {
        out.dt = { error: e.message };
        process.stdout.write(`[${SET}] ${spec.id} dt ERR: ${e.message}\n`);
      }
    }
    rows.push(out);
  }

  const lines = fs.existsSync(CSV) && fs.readFileSync(CSV, 'utf-8').trim() ? [] : [csvHeader];
  for (const r of rows) {
    for (const mode of ['plain', 'dt']) {
      const m = r[mode];
      if (!m || m.error || done.has(r.id + '|' + mode)) continue;
      lines.push([r.id, mode, m.pass ? 1 : 0, m.total, m.minAxis, ...(m.axes || [0, 0, 0, 0, 0]), m.html.length, m.ms, csvEscape(m.notes)].join(','));
    }
  }
  fs.appendFileSync(CSV, lines.join('\n') + '\n', 'utf-8');

  const summary = {
    model: MODEL, verifier: CRITIQUE_MODEL, depth: DEPTH, checks: CHECKS, date: new Date().toISOString(),
    rule: 'pass = total >= 42 && min axis >= 6',
    plain: { n: plainN, correct: plainOk, pct: plainN ? +(plainOk / plainN * 100).toFixed(1) : 0 },
    dt: { n: dtN, correct: dtOk, pct: dtN ? +(dtOk / dtN * 100).toFixed(1) : 0 },
    delta: dtN && plainN ? +(dtOk / dtN * 100 - plainOk / plainN * 100).toFixed(1) : 0,
  };
  fs.writeFileSync(path.join(RES, SET + '.summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  const md = [
    `# Coding (fresh HTML specs): plain vs deepthink`,
    '',
    `model: ${MODEL} | verifier: ${CRITIQUE_MODEL} | depth ${DEPTH} checks ${CHECKS}`,
    `pass rule: total ≥ 42 AND every axis ≥ 6`,
    '',
    '| mode | pass | pct |',
    '|---|---|---|',
    `| plain | ${plainOk}/${plainN} | ${summary.plain.pct}% |`,
    `| dt | ${dtOk}/${dtN} | ${summary.dt.pct}% |`,
    `| **delta** | | **+${summary.delta} pts** |`,
  ];
  fs.writeFileSync(path.join(RES, SET + '.table.md'), md.join('\n'), 'utf-8');

  console.log('\n' + md.join('\n'));
  console.log(`\n[${SET}] plain ${plainOk}/${plainN} (${summary.plain.pct}%) | dt ${dtOk}/${dtN} (${summary.dt.pct}%) | delta +${summary.delta} pts`);
  console.log(`[${SET}] saved ${CSV}`);
  process.exit(0);
})().catch((e) => { console.error('[' + SET + '] fatal:', e); process.exit(1); });
