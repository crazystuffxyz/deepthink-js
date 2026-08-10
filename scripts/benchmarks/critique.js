// scripts/benchmarks/critique.js
// exactly 2 calls to minimax-m3:cloud — one per HTML file produced by
// codeAgent.js. each call scores 5 axes (1-10) and emits a total.
// we keep the prompt tight and force JSON-only output.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Ollama } from 'ollama';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', '..', 'benchmarks', 'results', 'coding');
const CRITIQUE_MODEL = process.env.BENCH_VERIFIER || 'deepseek-v4-flash:0731-cloud';

const SYSTEM = `You are a strict senior frontend reviewer. You are given a single self-contained HTML file. You score it on 5 axes from 1 to 10 each, integer only. Be ruthless but fair.

Axes:
  correctness    - does it actually implement the spec? does the JS work?
  completeness   - does it cover every numbered requirement?
  code_quality   - structure, naming, no dead code, no eval, sane globals
  ux             - controls, feedback, default state, visual polish
  perf           - reasonable 60fps loop, no leaks, no allocation in hot path

Reply with ONLY a JSON object, no markdown fences, no prose:
{"correctness":N,"completeness":N,"code_quality":N,"ux":N,"perf":N,"total":N,"notes":"one or two sentences"}`;

const USER = (id, html) => `Spec id: ${id}

File contents (size=${html.length} chars):
\`\`\`html
${html.slice(0, 60_000)}
\`\`\`

Score the file. JSON only.`;

function extractJson(text) {
  if (!text) return null;
  const t = String(text);
  // try fenced
  const fb = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fb ? fb[1] : t;
  // try to find a JSON object
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function main() {
  const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

  const targets = [
    { name: 'plain', file: path.join(OUT, 'plain.html') },
    { name: 'dt', file: path.join(OUT, 'dt.html') },
  ];

  const out = { model: CRITIQUE_MODEL, axes: ['correctness', 'completeness', 'code_quality', 'ux', 'perf'], scores: {} };

  for (const t of targets) {
    if (!fs.existsSync(t.file)) {
      out.scores[t.name] = { error: 'file not found' };
      continue;
    }
    const html = fs.readFileSync(t.file, 'utf-8');
    const t0 = Date.now();
    let text = '';
    try {
      const r = await ollama.chat({
        model: CRITIQUE_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER('gravity-sandbox', html) },
        ],
        stream: false,
      });
      text = (r && r.message && r.message.content) || (r && r.content) || '';
    } catch (e) {
      text = `ERR: ${e.message}`;
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const j = extractJson(text);
    out.scores[t.name] = {
      seconds: parseFloat(sec),
      raw: text.slice(0, 4000),
      parsed: j,
    };
    if (j) {
      console.log(
        `${t.name.padEnd(5)}  total=${j.total}  correctness=${j.correctness} completeness=${j.completeness} code=${j.code_quality} ux=${j.ux} perf=${j.perf}  (${sec}s)`
      );
    } else {
      console.log(`${t.name.padEnd(5)}  unparseable (${sec}s): ${text.slice(0, 200)}`);
    }
  }

  fs.writeFileSync(path.join(OUT, 'critique.json'), JSON.stringify(out, null, 2));
  console.log(`wrote ${path.join(OUT, 'critique.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
