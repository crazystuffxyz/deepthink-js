// scripts/applyBest.js — apply the best evolved prompt to a hard problem.
// usage:
//   node scripts/applyBest.js <runId> <prompt>
//   node scripts/applyBest.js <runId> <prompt> --no-trace
//   node scripts/applyBest.js <runId> <prompt> --raw
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { applyEvolvedPrompt, applyEvolvedPromptWithTrace, splitTrace, loadBest } from '../thinking/evolvedThinking.js';

const args = process.argv.slice(2);
const showTrace = !args.includes('--no-trace') && !args.includes('--raw');
const filtered = args.filter(a => !a.startsWith('--'));
const runId = filtered[0];
const prompt = filtered.slice(1).join(' ');
if (!runId || !prompt) {
  console.error('usage: node scripts/applyBest.js <runId> <prompt> [--no-trace|--raw]');
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
console.log(`[apply] system prompt: ${best.systemPrompt.slice(0, 200)}...`);
console.log(`[apply] problem: ${prompt.slice(0, 200)}`);
(async () => {
  try {
    if (showTrace) {
      const r = await applyEvolvedPromptWithTrace(dt.callChat.bind(dt), best.systemPrompt, prompt, {});
      if (r.hadThinkBlock) {
        console.log('\n[apply] --- think trace ---\n');
        console.log(r.think);
        console.log('\n[apply] --- final answer ---\n');
        console.log(r.answer);
      } else {
        console.log('\n[apply] (no visible think block in response)');
        console.log('\n[apply] --- response ---\n');
        console.log(r.answer);
      }
    } else {
      const r = await applyEvolvedPrompt(dt.callChat.bind(dt), best.systemPrompt, prompt, {});
      console.log('\n[apply] --- response ---\n');
      console.log(r);
    }
  } catch (e) {
    console.error('[apply] FAIL:', e.message);
    process.exit(1);
  }
})();
