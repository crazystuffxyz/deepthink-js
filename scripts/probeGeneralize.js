// scripts/probeGeneralize.js — apply the best evolved prompt to 3 out-of-distribution
// hard problems and print the responses. if the responses look generic or the prompt
// appears to have overfit the benchmark, you know to adjust the scoring weights
// or the benchmark distribution.
// usage: node scripts/probeGeneralize.js <runId>
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { applyEvolvedPromptWithTrace, loadBest } from '../thinking/evolvedThinking.js';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: node scripts/probeGeneralize.js <runId>');
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
const dt = new Deepthink(model, [], opts);

const problems = [
  { kind: 'planning', q: 'Design a fair consensus protocol for 3 mutually distrustful parties with no trusted dealer. Be specific about the message types and the failure assumptions.' },
  { kind: 'code', q: 'Write a Python function `dedupe_preserve_order(xs)` that returns a list of the unique elements of xs in their first-occurrence order. Then write three test cases that would catch a naive set-based implementation.' },
  { kind: 'hypothesis', q: 'A coffee chain opens a new store 6 months after a competitor opens across the street. They claim the second store is purely reactive to demand. Construct two testable alternative hypotheses and the observations that would distinguish them from the official story.' }
];

console.log(`[probe] using best: ${best.id} op=${best.operator} sysLen=${best.systemPrompt.length}`);

(async () => {
  for (const p of problems) {
    console.log(`\n${'='.repeat(60)}\n[probe] kind=${p.kind}\n[probe] problem: ${p.q}\n${'='.repeat(60)}`);
    try {
      const r = await applyEvolvedPromptWithTrace(dt.callChat.bind(dt), best.systemPrompt, p.q, {});
      if (r.hadThinkBlock) {
        console.log(`\n[think]\n${r.think}\n`);
        console.log(`[answer]\n${r.answer}\n`);
      } else {
        console.log(`\n[response]\n${r.answer}\n`);
      }
    } catch (e) {
      console.error(`[probe] FAIL on ${p.kind}: ${e.message}`);
    }
  }
})();
