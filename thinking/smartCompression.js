// thinking/smartCompression.js — when context overflows, ask the LLM to compress
'use strict';

import { stripThinkBlocks, messagesToText } from './dataTypes.js';

function approxTokens(text) {
  // rough: 1 token ~= 4 chars for english/code
  return Math.ceil((text || '').length / 4);
}

function totalTokens(messages) {
  let n = 0;
  for (const m of messages) n += approxTokens(m.content);
  return n;
}

function oldestSystem(messages) {
  return messages.findIndex(m => m.role !== 'system');
}

async function compress(callChat, messages, opts = {}) {
  const max = opts.maxTokens || 6000;
  if (totalTokens(messages) <= max) return messages;
  // find a compressible block: oldest non-system pair (assistant+user) before the tail
  const cutAt = Math.max(0, oldestSystem(messages) + 1);
  const head = messages.slice(0, cutAt);
  const middle = messages.slice(cutAt, -2);
  const tail = messages.slice(-2);
  if (!middle.length) return messages;
  const blob = middle.map((m, i) => `[${m.role.toUpperCase()} ${i + 1}]\n${m.content}`).join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'Compress the following conversation excerpt into the smallest set of facts that ' +
          'preserves decisions, constraints, numbers, and named entities. Drop filler and ' +
          'redundancy. Output plain text only — no labels, no markdown.'
      },
      { role: 'user', content: blob }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  const summary = stripThinkBlocks(r.content || '').trim();
  if (!summary) return messages;
  return [
    ...head,
    { role: 'system', content: `[COMPRESSED CONTEXT]\n${summary}` },
    ...tail
  ];
}

// Truncate from the middle, keep first and last N
function truncateMiddle(messages, keepFirst = 4, keepLast = 8) {
  if (messages.length <= keepFirst + keepLast) return messages;
  return [
    ...messages.slice(0, keepFirst),
    { role: 'system', content: `[... ${messages.length - keepFirst - keepLast} earlier messages truncated ...]` },
    ...messages.slice(-keepLast)
  ];
}

export { compress, truncateMiddle, totalTokens, approxTokens };
