// scripts/benchmarks/buildHmmtGuts.js
// rebuild benchmarks/data/hmmt-feb2026.jsonl (36 problems) from the raw
// HMMT Feb 2026 GUTS round txt dumps. the earlier partial build skipped 6
// problems (g05, g13, g16, g17, g23, g28) — this regenerates the whole set.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'benchmarks', 'fresh2026');
const OUT = path.join(ROOT, 'benchmarks', 'data', 'hmmt-feb2026.jsonl');

const problemsTxt = fs.readFileSync(path.join(SRC, 'hmmt_feb2026_guts_problems.txt'), 'utf-8');
const solutionsTxt = fs.readFileSync(path.join(SRC, 'hmmt_feb2026_guts_solutions.txt'), 'utf-8');

// --- problems: split on "N. [P]" headers ---
const lines = problemsTxt.split('\n');
const blocks = []; // {num, points, textLines[]}
let cur = null;
for (const line of lines) {
  const m = line.match(/^(\d+)\. \[(\d+)\]/);
  if (m) {
    cur = { num: Number(m[1]), points: Number(m[2]), textLines: [line.slice(m[0].length).trim()] };
    blocks.push(cur);
  } else if (cur) {
    cur.textLines.push(line);
  }
}

// --- strip page furniture: dot lines, page markers, headers, footers ---
const junk = /^\.{3,}$|^-- \d+ of \d+ --$|^HMMT February 2026|^Organization Team|^©2026 HMMT$/;
const problems = blocks.map(b => ({
  num: b.num,
  points: b.points,
  text: b.textLines.filter(l => !junk.test(l.trim())).join('\n').trim()
}));

// --- answers: "Answer: X" lines in order ---
// some answers are two-line fractions ("Answer: 53" then "144" on the next
// line = 53/144) — join a bare-number continuation as the denominator.
const cleanAnswer = (a) => {
  let t = a.replace(/^≈\s*/, '').trim();
  const eq = t.lastIndexOf(' = ');
  if (eq >= 0) t = t.slice(eq + 3).trim();
  return t;
};

const solLines = solutionsTxt.split('\n');
const answers = [];
for (let i = 0; i < solLines.length; i++) {
  const l = solLines[i];
  if (!/^Answer:/.test(l)) continue;
  let a = cleanAnswer(l.replace(/^Answer:\s*/, ''));
  const next = solLines[i + 1] || '';
  if (/^\s*\d+\s*$/.test(next)) {
    // "(1 − π)/4" needs parens; "7√11/11" doesn't
    a = /[+\-−·\s]/.test(a) ? '(' + a + ')/' + next.trim() : a + '/' + next.trim();
  }
  answers.push(a);
}

if (problems.length !== 36) throw new Error(`expected 36 problems, got ${problems.length}`);
if (answers.length !== 36) throw new Error(`expected 36 answers, got ${answers.length}`);

const rows = problems.map((p, i) => ({
  id: `hmmt-g${String(p.num).padStart(2, '0')}`,
  source: 'hmmt-feb2026-guts',
  kind: 'math',
  problem: p.text,
  answer: cleanAnswer(answers[i])
}));

fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

// --- verify ---
const missing = [];
for (let n = 1; n <= 36; n++) {
  if (!rows.some(r => r.id === `hmmt-g${String(n).padStart(2, '0')}`)) missing.push(n);
}
console.log(`wrote ${rows.length} problems → ${OUT}`);
console.log(`missing: ${missing.length ? missing.join(', ') : 'none'}`);
for (const n of [5, 13, 16, 17, 23, 28]) {
  const r = rows.find(x => x.id === `hmmt-g${String(n).padStart(2, '0')}`);
  console.log(`g${String(n).padStart(2, '0')}: ${r ? r.answer + ' — ' + r.problem.slice(0, 60) : 'MISSING'}`);
}
