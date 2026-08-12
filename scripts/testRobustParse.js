// scripts/testRobustParse.js
// verify the robust compute-orchestrator JSON parse against the two
// responses that broke it (a26ii-03, a26ii-13) + edge cases.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'benchmarks', 'results', 'traces');

const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function robustParse(txt) {
  const t = (txt || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  let p = tryParse(t);
  if (!p) {
    const start = t.indexOf('{');
    if (start >= 0) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            const cand = t.slice(start, i + 1);
            p = tryParse(cand);
            if (!p) {
              p = tryParse(
                cand
                  .replace(/\\([^"\\/bfnrtu])/g, '\\\\$1')
                  .replace(/\\(u)(?![0-9a-fA-F]{4})/g, '\\\\$1')
              );
            }
            break;
          }
        }
      }
    }
  }
  return p;
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got).slice(0, 120)} want ${JSON.stringify(want).slice(0, 120)}`); }
};

// 1) the two real broken responses
for (const f of ['aime-2026-II-a26ii-03.json', 'aime-2026-II-a26ii-13.json']) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
  const comp = t.events.find(e => e.phase === 'compute');
  const p = robustParse(comp.response);
  check(`${f} mode`, p && p.mode, 'single');
  check(`${f} task non-empty`, typeof (p && p.task) === 'string' && p.task.length > 0, true);
  console.log(`  ${f}: mode=${p && p.mode} taskLen=${p && p.task ? p.task.length : 0}`);
}

// 2) clean JSON still parses
check('clean', robustParse('{"mode":"single","task":"compute 2^10"}'), { mode: 'single', task: 'compute 2^10' });

// 3) prose before JSON
check('prose prefix', robustParse('Here you go:\n{"mode":"parallel","tasks":["a","b","c"]}'), { mode: 'parallel', tasks: ['a', 'b', 'c'] });

// 4) bad escape inside task — the raw JSON text has \d (invalid escape)
const badEscapeRaw = '{"mode":"single","task":"re.split(\'\\d+\', s)"}';
check('bad escape', robustParse(badEscapeRaw), { mode: 'single', task: "re.split('\\d+', s)" });

// 5) \u with non-hex
check('bad unicode', robustParse('{"mode":"single","task":"\\\\uZZZ"}'), { mode: 'single', task: '\\uZZZ' });

// 6) valid \u escape untouched
check('good unicode', robustParse('{"mode":"single","task":"\\\\u0041"}'), { mode: 'single', task: '\\u0041' });

// 7) mode none
check('none', robustParse('{"mode":"none"}'), { mode: 'none' });

// 8) garbage
check('garbage', robustParse('not json at all'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
