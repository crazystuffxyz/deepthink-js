// scripts/iqTestSC.js — apply self-consistency (sample N, vote) to the IQ test.
// usage: node scripts/iqTestSC.js [samples]
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { PATTERNS, composePrompt } from '../thinking/thinkingPatterns.js';
import { selfConsistency } from '../thinking/consistency.js';

const samples = parseInt(process.argv[2] || '5', 10);

function voteNumeric(arr) {
  // most common number, ties broken by smallest
  const counts = new Map();
  for (const x of arr) {
    if (x == null) continue;
    counts.set(x, (counts.get(x) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null, bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && (best == null || k < best))) { best = k; bestN = n; }
  }
  return best;
}

// use the best hand-tuned prompt
const picks = ['sequence-mine', 'eliminate-systematically', 'commit-and-defend', 'extract-constraints', 'feynman-decompose'];
const ps = picks.map(n => PATTERNS.find(p => p.name === n));
const systemPrompt = composePrompt(ps, { tone: 'didactic' });

const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';
const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
const dt = new Deepthink(model, [], opts);
const callChat = dt.callChat.bind(dt);

console.log(`[iq-sc] using ${samples}-sample self-consistency`);

const ALL = {
  sequence: [
    { id: 's01', q: '4, 9, 16, 25, 36, ___?', choices: ['21', '28', '36', '45'], answer: 0 },
    { id: 's02', q: '18, 15, 20, 17, 22, ?, ?', choices: ['18 and 23', '19 and 24', '20 and 25', '18 and 24'], answer: 1 },
    { id: 's03', q: '1, 2, 5, 14, 41, ___?', choices: ['52', '64', '81', '103'], answer: 2 },
    { id: 's04', q: '1, 8, 27, ___?', choices: ['33', '64', '71', '73'], answer: 1 },
    { id: 's05', q: '2, 3, 5, 7, 11, ___?', choices: ['13', '15', '19', '20'], answer: 0 },
    { id: 's06', q: '3, 5, 8, 13, 21, 34, ___?', choices: ['47', '50', '55', '63'], answer: 2 },
    { id: 's07', q: '4, 12, 36, 108, ___?', choices: ['209', '324', '972', '1003'], answer: 1 },
    { id: 's08', q: '24, 21, 19, 18, 15, 13, ?, ?, 7', choices: ['10, 9', '11, 8', '12, 9', '11, 9'], answer: 2 },
    { id: 's09', q: '14916253649___', choices: ['2438', '8775', '3141', '6481'], answer: 3 },
    { id: 's10', q: '6, 8, 10, 11, 14, 14, ___?', choices: ['18', '20', '22', '24'], answer: 0 }
  ],
  oddOneOut: [
    { id: 'o01', q: 'Which does not fit? Silver, Copper, Gold', choices: ['Silver', 'Copper', 'Gold', 'None'], answer: 1 },
    { id: 'o02', q: 'Which does not fit? Kangaroo, Koala, Lion', choices: ['Kangaroo', 'Koala', 'Lion', 'None'], answer: 2 },
    { id: 'o03', q: 'Which does not fit? Islam, Judaism, Buddhism', choices: ['Islam', 'Judaism', 'Buddhism', 'None'], answer: 2 },
    { id: 'o04', q: 'Which does not fit? Deed, Level, Nun, Plan', choices: ['Deed', 'Level', 'Nun', 'Plan'], answer: 3 },
    { id: 'o05', q: 'Which does not fit? Color: Blue, Pink, Green, Purple, Yellow', choices: ['Blue', 'Pink', 'Green', 'Purple'], answer: 1 }
  ],
  text: [
    { id: 't01', q: 'It is a quarter to twelve. If the hour and minute hands are reversed, what time is shown?', choices: ['6:15', '6:45', '3:45', '9:00'], answer: 3 },
    { id: 't02', q: 'How many cuts are needed to cut a log into 11 pieces?', choices: ['11', '10', '9', '12'], answer: 1 },
    { id: 't03', q: 'How many pages in a book if it takes 35 digits to number them?', choices: ['28', '22', '16', '14'], answer: 1 },
    { id: 't04', q: 'How many times does the number 1 appear from 1 to 100?', choices: ['21', '19', '17', '18'], answer: 0 },
    { id: 't05', q: 'Pen + notebook = $1.10; notebook $1.00 more than pen. Pen cost?', choices: ['$0.5', '$0.05', '$0.10', '$1.00'], answer: 1 }
  ],
  trueFalse: [
    { id: 'f01', q: 'First satellite launched was Sputnik II.', choices: ['True', 'False'], answer: 1 },
    { id: 'f02', q: 'Acrophobia = fear of death.', choices: ['True', 'False'], answer: 1 },
    { id: 'f03', q: 'Yuri Gagarin was the first to walk on the Moon.', choices: ['True', 'False'], answer: 1 },
    { id: 'f04', q: 'The shortest war in history lasted a day.', choices: ['True', 'False'], answer: 1 },
    { id: 'f05', q: 'Sum of interior angles of a triangle is 180°.', choices: ['True', 'False'], answer: 0 }
  ]
};

const banks = Object.values(ALL).flat();

function formatQ(item) {
  const choiceStr = item.choices.map((c, i) => `(${i + 1}) ${c}`).join('  ');
  return `${item.q}\n\n${choiceStr}\n\nAnswer with the single number (1-${item.choices.length}) of the correct choice. End your response with a line that says exactly: ANSWER: <number>.`;
}

function parseAnswer(text) {
  const m = String(text || '').match(/ANSWER:\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const nums = String(text || '').match(/\d+/g);
  if (nums) return parseInt(nums[nums.length - 1], 10);
  return null;
}

// sample N times, vote on extracted numeric answer
async function scNumeric(callChat, messages, n, temp) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(callChat(messages, false, null, {
      provider: opts.provider,
      host: opts.host,
      think: false,
      autoSystemPrompt: false,
      temperature: temp
    }).then(r => parseAnswer(r.content)));
  }
  const out = await Promise.all(tasks);
  return { winner: voteNumeric(out), samples: out };
}

(async () => {
  let correct = 0, total = 0;
  const results = [];
  for (const item of banks) {
    total++;
    process.stdout.write(`[iq-sc] ${item.id} ${item.q.slice(0, 40)}... `);
    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: formatQ(item) }
      ];
      const sc = await scNumeric(callChat, messages, samples, 0.5);
      const ans = sc.winner;
      const ok = ans === item.answer + 1;
      if (ok) correct++;
      results.push({ id: item.id, expected: item.answer + 1, got: ans, ok, samples: sc.samples });
      process.stdout.write(`${ok ? '✓' : '✗'} expected=${item.answer + 1} got=${ans} votes=${sc.samples.filter(s => s != null).sort().join(',')}\n`);
    } catch (e) {
      results.push({ id: item.id, error: e.message });
      process.stdout.write(`ERR: ${e.message}\n`);
    }
  }
  const pct = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';
  console.log(`\n[iq-sc] score: ${correct}/${total} = ${pct}% (samples=${samples})`);
  const outDir = path.join(process.cwd(), 'data', 'iq');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `iq-sc-${samples}samples.json`);
  fs.writeFileSync(outFile, JSON.stringify({ model, samples, correct, total, results, systemPrompt: systemPrompt.slice(0, 200) }, null, 2), 'utf-8');
  console.log(`[iq-sc] saved ${outFile}`);
})();
