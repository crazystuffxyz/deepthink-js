// scripts/applyBest.js — apply the best evolved prompt to a hard problem.
// usage: node scripts/applyBest.js <runId> <prompt>
//   runId: timestamp/folder under data/evolved/
//   prompt: the hard problem to solve
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { applyEvolvedPrompt, loadBest } from '../thinking/evolvedThinking.js';

const runId = process.argv[2];
const prompt = process.argv.slice(3).join(' ');
if (!runId || !prompt) {
  console.error('usage: node scripts/applyBest.js <runId> <prompt>');
  process.exit(1);
}
const runDir = path.join(process.cwd(), 'data', 'evolved', runId);
if (!fs.existsSync(runDir)) {
  console.error(`no run dir: ${runDir}`);
  process.exit(1);
}
const best = loadBest(runDir);
const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';
const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
if (process.env.OPENAI_API_KEY) opts.apiKey = process.env.OPENAI_API_KEY;
const dt = new Deepthink(model, [], opts);

console.log(`[apply] using best: ${best.id} fitness=${best.fitness?.toFixed?.(3) || '?'} op=${best.operator}`);
console.log(`[apply] prompt: ${prompt.slice(0, 200)}`);
(async () => {
  try {
    const r = await applyEvolvedPrompt(dt.callChat.bind(dt), best.systemPrompt, prompt, {});
    console.log('\n[apply] response:\n');
    console.log(r);
  } catch (e) {
    console.error('[apply] FAIL:', e.message);
    process.exit(1);
  }
})();
