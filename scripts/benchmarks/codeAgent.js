// scripts/benchmarks/codeAgent.js
// generate two standalone HTML files implementing the same spec:
//   - benchmarks/results/coding/plain.html  (plain ollama)
//   - benchmarks/results/coding/dt.html     (Deepthink d=3 c=2)
//
// we use gemma4:31b-cloud for both. same prompt, same spec, same
// model — the only difference is the deepthink orchestration. the
// prompt asks the model to wrap the html in a sentinel block so we
// can extract it cleanly.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', '..', 'benchmarks', 'results', 'coding');
const DATA = path.resolve(__dirname, '..', '..', 'benchmarks', 'data', 'coding.jsonl');
const MODEL = 'minimax-m3:cloud';
const DEPTH = 2;
const CHECKS = 2;

const rows = fs
  .readFileSync(DATA, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (rows.length !== 1) {
  console.error(`expected 1 row in coding.jsonl, got ${rows.length}`);
  process.exit(1);
}
const spec = rows[0];

const systemPrompt = `You are a senior frontend engineer. You write production-grade, self-contained HTML. You respond with exactly one file wrapped in a sentinel block. NEVER use placeholders, "..." or "rest of code here". NEVER include external network calls. NEVER use <script src=...> with a remote URL. The HTML must be openable by double-clicking the file.

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
  // fallback: a fenced ```html block
  const fb = String(text).match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fb) return fb[1].trim();
  // fallback: longest <!doctype>...</html> span
  const dt = String(text).match(/<!doctype[\s\S]*?<\/html>/i);
  if (dt) return dt[0];
  return String(text).trim();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
  const plain = dt.buildClient(null);

  // 1) plain ollama
  const t0 = Date.now();
  let plainText = '';
  try {
    const r = await plain.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt(spec.spec) },
      ],
      stream: false,
    });
    plainText = (r && r.content) || '';
  } catch (e) {
    plainText = `ERR: ${e.message}`;
  }
  const plainHtml = extractHtml(plainText);
  const plainPath = path.join(OUT, 'plain.html');
  fs.writeFileSync(plainPath, plainHtml, 'utf-8');
  const plainSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`plain  ollama -> ${plainPath}  (${plainHtml.length} chars, ${plainSec}s)`);

  // 2) deepthink d=3 c=2
  const t1 = Date.now();
  let dtText = '';
  try {
    const out = await dt.generate(userPrompt(spec.spec), {
      depth: DEPTH,
      checks: CHECKS,
      system: systemPrompt,
    });
    dtText = typeof out === 'string' ? out : (out && (out.answer || out.output || out.content || out.text || out.result)) || '';
  } catch (e) {
    dtText = `ERR: ${e.message}`;
  }
  const dtHtml = extractHtml(dtText);
  const dtPath = path.join(OUT, 'dt.html');
  fs.writeFileSync(dtPath, dtHtml, 'utf-8');
  const dtSec = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`dt(d=3 c=2)   -> ${dtPath}  (${dtHtml.length} chars, ${dtSec}s)`);

  fs.writeFileSync(
    path.join(OUT, 'meta.json'),
    JSON.stringify(
      {
        model: MODEL,
        depth: DEPTH,
        checks: CHECKS,
        spec_id: spec.id,
        plain_bytes: plainHtml.length,
        dt_bytes: dtHtml.length,
        plain_seconds: parseFloat(plainSec),
        dt_seconds: parseFloat(dtSec),
      },
      null,
      2
    )
  );
  console.log(`wrote ${path.join(OUT, 'meta.json')}`);

  dt.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
