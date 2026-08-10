// scripts/testMultimodal.js
// live multimodal test: text-only model (gemma4:31b-cloud) + vision model
// fallback. the image is an SVG with a math question; the vision model must
// transcribe it, then the main model must answer 42.
//
// usage:
//   node scripts/testMultimodal.js [--image path] [--model X] [--vision Y]

import path from 'path';
import { fileURLToPath } from 'url';
import Deepthink from '../dist/thinking/deepthink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const IMG = arg('image', path.join(ROOT, 'benchmarks', 'research', 'test-image.svg'));
const MODEL = arg('model', 'gemma4:31b-cloud');
const VISION = arg('vision', process.env.DEEPTHINK_VISION_MODEL || 'qwen3-vl:235b-instruct-cloud');

const dt = new Deepthink(MODEL, [], { provider: 'ollama' });

async function main() {
  console.log(`[mm] model=${MODEL} vision=${VISION} image=${IMG}`);
  const t0 = Date.now();
  const r = await dt.generate('Look at the attached image and answer the question it asks. Give ONLY the number as your answer.', {
    images: [IMG],
    visionModel: VISION,
    depth: 0,
    temperature: 0.1,
  });
  const ms = Date.now() - t0;
  const text = typeof r === 'object' && r !== null ? JSON.stringify(r) : String(r);
  console.log(`[mm] answer: ${text.slice(0, 300)}`);
  console.log(`[mm] ${(ms / 1000).toFixed(1)}s`);
  const ok = /42/.test(text);
  console.log(`[mm] ${ok ? 'PASS — got 42' : 'FAIL — expected 42'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[mm] fatal:', e); process.exit(1); });
