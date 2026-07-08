// test_integration.js — end-to-end against the default test model (gemma4:31b-cloud)
// Tests each new public option in Deepthink.generate() with a small Q that has a known answer.
'use strict';

import Deepthink from '../thinking/deepthink.js';

const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';
const apiKeys = [];
const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
if (process.env.OPENAI_API_KEY) opts.apiKey = process.env.OPENAI_API_KEY;

const dt = new Deepthink(model, apiKeys, opts);
const callChat = dt.callChat.bind(dt);

async function test(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const t0 = Date.now();
    await fn();
    console.log(`OK (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
    throw e;
  }
}

(async () => {
  // 1. plain string
  await test('generate: plain string', async () => {
    const r = await dt.generate('Reply with the single word: ok');
    if (typeof r !== 'string' || r.length < 1) throw new Error('expected non-empty string, got: ' + JSON.stringify(r));
  });

  // 2. typed integer
  await test('generate: integer type', async () => {
    const r = await dt.generate('What is 5 + 7? Reply with just the number.', { type: 'integer', depth: 0, checks: 0 });
    if (r !== 12) throw new Error('expected 12, got ' + r);
  });

  // 3. self-consistency
  await test('generate: selfConsistency', async () => {
    const r = await dt.generate('What is 6 * 7? Reply with just the number.', {
      type: 'integer', depth: 0, selfConsistency: true, selfConsistencySamples: 3
    });
    if (r !== 42) throw new Error('expected 42, got ' + r);
  });

  // 4. plan-and-execute
  await test('generate: planExecute', async () => {
    const r = await dt.generate('List the first 3 prime numbers, comma separated, nothing else.', {
      type: 'string', depth: 0, planExecute: true
    });
    if (!/2/.test(r) || !/3/.test(r) || !/5/.test(r)) throw new Error('expected 2,3,5 in: ' + r);
  });

  // 5. debate
  await test('generate: debate', async () => {
    const r = await dt.generate('Is the sky blue? Answer yes or no, one word.', {
      type: 'string', depth: 0, debate: true, debateRounds: 1
    });
    if (typeof r !== 'string' || r.length < 1) throw new Error('empty');
  });

  // 6. tools (default tools incl. finish)
  await test('generate: tools loop', async () => {
    const r = await dt.generate('Compute 11 * 11. You MUST output ONLY this JSON: {"tool":"js_eval","params":{"code":"console.log(11*11)"}}', {
      type: 'string', depth: 0, tools: true, maxSteps: 4
    });
    if (!/121/.test(String(r))) throw new Error('expected 121 in: ' + JSON.stringify(r));
  });

  // 7. reflexion — no lesson yet, but path runs
  await test('generate: reflexion (no lessons yet)', async () => {
    const r = await dt.generate('What is the capital of France? Reply with just the city name.', {
      type: 'string', depth: 0, reflexion: true
    });
    if (!/paris/i.test(String(r))) throw new Error('expected Paris in: ' + r);
  });

  // 8. calibrate (just exercise the path; no truth to compare)
  await test('generate: calibrate flag', async () => {
    const r = await dt.generate('What is 9 + 10? Reply with just the number.', {
      type: 'integer', depth: 0, calibrate: true
    });
    if (r !== 19) throw new Error('expected 19, got ' + r);
  });

  // 9. depth=2 plus typing — slower, but exercises multi-stage think
  await test('generate: depth=2 with type=string', async () => {
    const r = await dt.generate('Name a fruit that is yellow. Reply with just the word.', {
      type: 'string', depth: 2, checks: 0
    });
    if (typeof r !== 'string' || r.length < 3) throw new Error('empty');
  });

  // 10. selfConsistency module direct
  await test('selfConsistency module direct', async () => {
    const { selfConsistency } = await import('../thinking/consistency.js');
    const r = await selfConsistency(callChat, 'What is 8 + 14? Reply with just the number.', {
      samples: 3, samplingProfile: 'verify', autoSystemPrompt: false
    });
    if (!/22/.test(r.answer)) throw new Error('expected 22, got ' + r.answer);
  });

  // 11. compress module direct — under budget
  await test('compress module direct (under budget)', async () => {
    const { compress } = await import('../thinking/smartCompression.js');
    const msgs = [{ role: 'user', content: 'short' }];
    const out = await compress(callChat, msgs, { maxTokens: 10000 });
    if (out.length !== 1) throw new Error('expected passthrough');
  });

  // 12. debate module direct
  await test('runDebate module direct', async () => {
    const { runDebate } = await import('../thinking/personaDebate.js');
    const r = await runDebate(callChat, 'Is 2+2=4? yes/no', { debateRounds: 1 });
    if (typeof r.answer !== 'string') throw new Error('no answer');
  });

  // 13. planAndExecute module direct
  await test('runPlanAndExecute module direct', async () => {
    const { runPlanAndExecute } = await import('../thinking/planAndExecute.js');
    const r = await runPlanAndExecute(callChat, 'What is 12 * 12?', { reflect: false });
    if (!/144/.test(r.answer)) throw new Error('expected 144, got ' + r.answer);
  });

  // 14. mixtureOfAgents direct — needs at least 2 entries with possibly-different bound clients
  await test('runMoA module direct', async () => {
    const { runMoA } = await import('../thinking/mixtureOfAgents.js');
    // bind two callers that each default to the same model
    const m1 = { name: 'gemma4:31b-cloud', callChat: (msgs, stream, cb, o) => callChat(msgs, stream, cb, { ...o, model: 'gemma4:31b-cloud' }) };
    const m2 = { name: 'gemma4:31b-cloud', callChat: (msgs, stream, cb, o) => callChat(msgs, stream, cb, { ...o, model: 'gemma4:31b-cloud' }) };
    const judge = (msgs, stream, cb, o) => callChat(msgs, stream, cb, { ...o, model: 'gemma4:31b-cloud' });
    const r = await runMoA([m1, m2], judge, 'What is 3 * 3? Reply with just the number.', { think: false, autoSystemPrompt: false });
    if (typeof r.answer !== 'string' || r.answer.length === 0) throw new Error('no answer from MoA');
  });

  console.log('integration: ALL PASS');
})().catch(e => { console.error('\nintegration: FAIL'); process.exit(1); });
