// thinking/reflexion.js — after a failure, write a lesson. reuse lessons on next tries.
'use strict';

import { stripThinkBlocks, messagesToText } from './dataTypes.js';

function keyFor(text) {
  // compress the input into a coarse fingerprint so we can match similar problems
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 12).join(' ');
}

function jaccard(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

function findRelevant(lessons, input, k = 3, threshold = 0.18) {
  const k1 = keyFor(input);
  if (!k1) return [];
  const scored = lessons
    .map(l => ({ l, s: jaccard(k1, l.key || '') }))
    .filter(x => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  return scored.map(x => x.l);
}

async function writeLesson(callChat, input, failure, opts) {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a reflexion agent. A previous attempt failed. Distill ONE general lesson that, ' +
          'if applied to similar future problems, would reduce the chance of the same failure. ' +
          'The lesson must be a single, terse, imperative sentence. No preamble.'
      },
      {
        role: 'user',
        content: `Problem: ${messagesToText(input).slice(0, 800)}\n\nFailure: ${failure}\n\nLesson:`
      }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

function makeStore(initial = []) {
  const lessons = [...initial];
  return {
    list() { return [...lessons]; },
    add(l) {
      const entry = { ...l, key: l.key || keyFor(l.input || ''), at: Date.now() };
      lessons.push(entry);
      return entry;
    },
    recall(input, k = 3) { return findRelevant(lessons, input, k); },
    size() { return lessons.length; }
  };
}

function attachReflexion(callChat, input, opts = {}) {
  const store = opts.memory instanceof Object && typeof opts.memory.list === 'function'
    ? opts.memory
    : makeStore(opts.lessons || []);
  return {
    store,
    async getHint() {
      const relevant = store.recall(messagesToText(input), opts.topK || 3);
      if (!relevant.length) return '';
      return 'PAST LESSONS — apply these if relevant:\n' + relevant.map((l, i) => `${i + 1}. ${l.lesson}`).join('\n');
    },
    async learn(failure) {
      const lesson = await writeLesson(callChat, input, failure, opts);
      return store.add({ input: messagesToText(input), lesson, key: keyFor(messagesToText(input)) });
    }
  };
}

export { attachReflexion, makeStore as makeReflexionStore, findRelevant, keyFor, writeLesson };
