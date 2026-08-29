// scripts/rlLoop.js — the always-on improvement loop.
//
// one cycle, small budget:
//   evolve (light pop/gens + mini-batched scoring) -> winner re-scored on the
//   full bank + OOD probe inside evolvePrompts -> regression guard vs the
//   state file -> record cycle -> optionally promote the prompt.
// state lives in data/evolved/rl-state.json (history + all-time best), and
// the champion prompt lands in data/evolved/rl-best.json in the same shape
// loadBest()/evolvedApply expect — so any generate({ evolvedApply:
// 'data/evolved/rl-best.json' }) picks it up automatically.
//
// usage:
//   node scripts/rlLoop.js                # one light cycle (pop 4, gens 2)
//   node scripts/rlLoop.js --loop 5       # 5 cycles back-to-back
//   node scripts/rlLoop.js --pop 8 --gens 3 --eval-sample 10
//   node scripts/rlLoop.js --no-promote   # measure only, never touch rl-best
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import Deepthink, { evolvePrompts, BENCH, OOD_BENCH } from '../dist/index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const CYCLES = parseInt(arg('loop', '1'), 10);
const POP = parseInt(arg('pop', '4'), 10);
const GENS = parseInt(arg('gens', '2'), 10);
const EVAL_SAMPLE = parseInt(arg('eval-sample', '5'), 10);
const PROMOTE = !hasFlag('no-promote');
const model = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';

const stateDir = process.env.DEEPTHINK_RL_DIR || path.resolve('data/evolved');
const stateFile = path.join(stateDir, 'rl-state.json');
// loadBest() wants a DIRECTORY with summary.json inside — so the champion
// rides at data/evolved/rl-best/summary.json and evolvedApply points at rl-best
const bestDir = path.join(stateDir, 'rl-best');
const bestFile = path.join(bestDir, 'summary.json');
const REGRESSION_TOLERANCE = 0.05; // a champion only loses its seat by more than this

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { history: [], best: null }; }
}
function saveState(s) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

const opts = { provider: process.env.DEEPTHINK_TEST_PROVIDER || 'ollama' };
if (process.env.OLLAMA_HOST) opts.host = process.env.OLLAMA_HOST;
if (process.env.OPENAI_API_KEY) opts.apiKey = process.env.OPENAI_API_KEY;
const dt = new Deepthink(model, [], opts);

console.log(`[rl] model=${model} cycles=${CYCLES} pop=${POP} gens=${GENS} evalSample=${EVAL_SAMPLE} promote=${PROMOTE}`);

let state = loadState();
for (let n = 1; n <= CYCLES; n++) {
  const t0 = Date.now();
  console.log(`\n===== [rl] cycle ${n}/${CYCLES} =====`);
  let r;
  try {
    r = await evolvePrompts(dt.callChat.bind(dt), {
      popSize: POP,
      generations: GENS,
      evalSample: EVAL_SAMPLE,
      bench: BENCH,
      oodBench: OOD_BENCH,
    });
  } catch (e) {
    console.error(`[rl] cycle ${n} failed: ${e.message} — continuing with existing champion`);
    state.history.push({ ts: new Date().toISOString(), cycle: n, error: String(e.message).slice(0, 200) });
    saveState(state);
    continue;
  }
  const fit = Number(r.best?.fitness ?? 0);
  const ood = r.oodScore != null ? Number(r.oodScore) : null;
  const gap = ood != null ? fit - ood : null;
  const entry = {
    ts: new Date().toISOString(),
    cycle: n,
    runId: r.best?.id,
    runDir: r.runDir,
    fitness: fit,
    oodScore: ood,
    gap,
    operator: r.best?.operator,
    ms: Date.now() - t0,
  };
  // regression guard: the challenger replaces the champion only if it scores
  // at least as well — or loses by less than REGRESSION_TOLERANCE, in which
  // case freshness wins (near-equal challengers carry newer mutations)
  const prevBest = state.best?.fitness ?? 0;
  entry.promoted = fit >= prevBest - REGRESSION_TOLERANCE;
  if (entry.promoted && PROMOTE) {
    state.best = { runId: entry.runId, runDir: runDirAbs(r.runDir), fitness: fit, oodScore: ood, gap, ts: entry.ts };
    try {
      fs.mkdirSync(bestDir, { recursive: true });
      fs.copyFileSync(path.join(r.runDir, 'summary.json'), bestFile);
      console.log(`[rl] champion updated → ${fit.toFixed(3)} (prev ${prevBest.toFixed(3)})`);
    } catch (e) {
      console.error(`[rl] champion copy failed: ${e.message}`);
    }
  } else {
    console.log(`[rl] challenger ${fit.toFixed(3)} did not beat champion ${prevBest.toFixed(3)} — kept`);
  }
  state.history.push(entry);
  if (state.history.length > 200) state.history = state.history.slice(-200);
  saveState(state);
  console.log(`[rl] state: ${stateFile}  log: ${entry.runDir}`);
}

function runDirAbs(d) { return path.resolve(String(d)); }

console.log(`\n[rl] done. all-time best fitness: ${state.best ? state.best.fitness.toFixed(3) : '(none)'} — best file: ${bestFile}`);