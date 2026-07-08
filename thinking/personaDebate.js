// thinking/personaDebate.js — two agents argue, judge picks the winner
'use strict';

import { stripThinkBlocks, messagesToText } from './dataTypes.js';

// debate rounds. each agent tries to convince the other, judge picks the stronger side
async function debateRound(callChat, topic, persona, priorText, opts) {
  const sys = persona === 'A'
    ? 'You are Agent A. Make the strongest possible case for the correct answer. Be precise, cite assumptions. If you change your mind, say so explicitly. Keep it under 180 words.'
    : 'You are Agent B. Argue AGAINST Agent A. Find flaws, missing steps, alternative interpretations. Be specific. If A is right, say so. Keep it under 180 words.';
  const user = priorText
    ? `Topic: ${topic}\n\nOpponent's last statement:\n${priorText}\n\nYour response:`
    : `Topic: ${topic}\n\nState your opening position in under 180 words:`;
  const r = await callChat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

async function judge(callChat, topic, textA, textB, opts) {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are an impartial judge. Compare two agents\' answers and pick the stronger one. ' +
          'If neither is good, say so. Output ONLY valid JSON: ' +
          '{"winner":"A"|"B"|"tie","synthesis":"the final integrated answer","reason":"short reason"}'
      },
      {
        role: 'user',
        content: `Topic: ${topic}\n\nAgent A:\n${textA}\n\nAgent B:\n${textB}\n\nVerdict:`
      }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'verify' }
  );
  const m = (r.content || '').match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  // fall back: whichever was longer
  return { winner: textA.length >= textB.length ? 'A' : 'B', synthesis: textA.length >= textB.length ? textA : textB, reason: 'json parse failed, fell back to length' };
}

async function runDebate(callChat, input, opts = {}) {
  const topic = messagesToText(input);
  const rounds = Math.max(1, Math.min(opts.debateRounds || 2, 4));
  let a = '', b = '';
  for (let i = 0; i < rounds; i++) {
    a = await debateRound(callChat, topic, 'A', b, opts);
    b = await debateRound(callChat, topic, 'B', a, opts);
  }
  const v = await judge(callChat, topic, a, b, opts);
  return { topic, agentA: a, agentB: b, verdict: v, answer: v.synthesis || (v.winner === 'A' ? a : b) };
}

export { runDebate, debateRound, judge };
