// scripts/iqTest.js — apply the best evolved prompt to a sample of IQ test
// questions across 5 sections (sequence, pattern, odd-one-out, text, true/false).
// grades against the answer key without giving the model the answers.
// usage: node scripts/iqTest.js <runId> [section|all]
'use strict';

import fs from 'fs';
import path from 'path';
import Deepthink from '../thinking/deepthink.js';
import { applyEvolvedPromptWithTrace, loadBest } from '../thinking/evolvedThinking.js';

const runId = process.argv[2];
const section = process.argv[3] || 'all';
if (!runId) {
  console.error('usage: node scripts/iqTest.js <runId> [section]');
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

console.log(`[iq] using best: ${best.id} op=${best.operator} sysLen=${best.systemPrompt.length}`);

// 105-question test bank — answer key last. selected sample = 25 questions
// spread across all 5 sections so we get a representative signal without
// burning the whole day on evals.
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

let banks = section === 'all' ? Object.values(ALL).flat() : ALL[section];
if (!banks) {
  console.error(`no section: ${section}. valid: ${Object.keys(ALL).join(', ')}`);
  process.exit(1);
}

function formatQ(item) {
  const choiceStr = item.choices.map((c, i) => `(${i + 1}) ${c}`).join('  ');
  return `${item.q}\n\n${choiceStr}\n\nAnswer with the single number (1-${item.choices.length}) of the correct choice. End your response with a line that says exactly: ANSWER: <number>.`;
}

(async () => {
  let correct = 0, total = 0;
  const results = [];
  for (const item of banks) {
    total++;
    process.stdout.write(`[iq] ${item.id} ${item.q.slice(0, 40)}... `);
    try {
      const r = await applyEvolvedPromptWithTrace(dt.callChat.bind(dt), best.systemPrompt, formatQ(item), {});
      const ans = parseAnswer(r.answer);
      const ok = ans === item.answer + 1; // answers are 1-indexed in the prompt
      if (ok) correct++;
      results.push({ id: item.id, q: item.q, expected: item.answer + 1, got: ans, ok });
      process.stdout.write(`${ok ? '✓' : '✗'} expected=${item.answer + 1} got=${ans}\n`);
    } catch (e) {
      results.push({ id: item.id, error: e.message });
      process.stdout.write(`ERR: ${e.message}\n`);
    }
  }
  const pct = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';
  console.log(`\n[iq] score: ${correct}/${total} = ${pct}%`);
  fs.writeFileSync(
    path.join(runDir, `iq-${section}.json`),
    JSON.stringify({ runId, model, best: best.id, section, correct, total, results }, null, 2),
    'utf-8'
  );
  console.log(`[iq] saved ${path.join(runDir, `iq-${section}.json`)}`);
})();

function parseAnswer(text) {
  // look for "ANSWER: N" anywhere in the response
  const m = String(text || '').match(/ANSWER:\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  // fallback: last number
  const nums = String(text || '').match(/\d+/g);
  if (nums) return parseInt(nums[nums.length - 1], 10);
  return null;
}
