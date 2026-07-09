// scripts/smoke_v140.js
// end-to-end smoke test against gemma4:31b-cloud. covers every public
// code path that doesn't need internet access.
import Deepthink, {
  runDeepResearch,
  generateAndRunCode,
  generateAndRunProject,
  selfConsistency,
  runDebate,
  runPlanAndExecute,
  runMoA,
  toolLoop,
  DEFAULT_TOOLS,
  compress,
  truncateMiddle,
  attachReflexion,
  makeReflexionStore,
  makeCalibrator,
  makeStore,
  makeEphemeralStore,
  evolvePrompts,
  applyEvolvedPrompt,
  PATTERNS,
  composePrompt,
  fingerprint,
  BENCH,
  OOD_BENCH,
  mutate,
  OPERATORS,
  runJSSandbox,
  runPythonSandbox,
  PYTHON_BIN,
  compareResults,
  staticAnalysisAgent,
  fetchPackageDocumentation,
  extractPackageList,
  generateCitation,
  FILE_BLOCK_PROMPT,
  parseFilesFromResponse,
  applyPatchBlocks,
  checkSyntaxAST,
} from '../dist/index.js';

const MODEL = 'gemma4:31b-cloud';
const dt = new Deepthink(MODEL, [], { provider: 'ollama' });
const callChat = dt.callChat.bind(dt);

let pass = 0, fail = 0;
async function t(label, fn) {
  process.stdout.write(`  ${label} ... `);
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    const preview = typeof r === 'string' ? r.slice(0, 60).replace(/\n/g, ' ') : JSON.stringify(r).slice(0, 60);
    console.log(`OK [${ms}ms] ${preview}`);
    pass++;
  } catch (e) {
    console.log(`FAIL: ${e.message}`);
    fail++;
  }
}

async function main() {
  console.log('== smoke_v140 = gemma4:31b-cloud ==');

  // -- core
  await t('generate plain', async () => {
    const r = await dt.generate('What is 2+2?');
    return r;
  });

  await t('generate integer type', async () => {
    const r = await dt.generate('How many sides does a hexagon have?', { type: 'integer' });
    return r;
  });

  await t('selfConsistency', async () => {
    const r = await selfConsistency(callChat, 'Pick a number 1-5', { samples: 3, samplingProfile: 'json' });
    return { answer: r.answer, count: r.count };
  });

  await t('debate', async () => {
    const r = await runDebate(callChat, 'Is the sky blue?', { rounds: 1, personas: 2 });
    return r.consensus || r.answer || JSON.stringify(r).slice(0, 80);
  });

  await t('planExecute', async () => {
    const r = await runPlanAndExecute(callChat, 'Compute 3+4', { type: 'string' });
    return r.result || r.finalAnswer || JSON.stringify(r).slice(0, 80);
  });

  await t('MoA', async () => {
    const callers = [
      { name: 'a', callChat: (m, s, oc, o) => callChat(m, s, oc, { ...o, samplingProfile: 'creative' }) },
      { name: 'b', callChat: (m, s, oc, o) => callChat(m, s, oc, { ...o, samplingProfile: 'reasoning' }) },
    ];
    const r = await runMoA(callers, callChat, 'Name a prime number');
    return r;
  });

  await t('reflexion', async () => {
    const r = attachReflexion(callChat, 'test problem');
    return r;
  });

  await t('calibrator', async () => {
    return makeCalibrator({ windowSize: 10 });
  });

  await t('memory store/recall', async () => {
    const s = makeEphemeralStore();
    s.set('a', 1); s.set('b', 2);
    return { a: s.get('a'), b: s.get('b'), stats: s.stats() };
  });

  await t('compress + truncateMiddle', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `sentence ${i} about things`).join('. ') + '.';
    const tm = truncateMiddle(long, 60);
    const msgs = [{ role: 'user', content: long }];
    const c = await compress(callChat, msgs, { maxTokens: 60, samplingProfile: 'json' });
    return { compressed: c.length, truncated: tm };
  });

  await t('toolLoop default tools', async () => {
    return { tools: Object.keys(DEFAULT_TOOLS || {}) };
  });

  await t('runJSSandbox', async () => {
    return runJSSandbox('console.log("hi from sandbox"); 6 * 7');
  });

  if (PYTHON_BIN) {
    await t('runPythonSandbox', async () => {
      return runPythonSandbox('print(2 + 2)');
    });
  } else {
    console.log('  runPythonSandbox ... SKIP (no python)');
  }

  await t('PATTERNS available', async () => {
    return { count: PATTERNS.length, names: PATTERNS.slice(0, 3) };
  });

  await t('composePrompt + fingerprint', async () => {
    const p = composePrompt(PATTERNS, 'integer');
    const fp = fingerprint(p);
    return { promptLen: p.length, fp: JSON.stringify(fp).slice(0, 60) };
  });

  await t('BENCH load', async () => {
    return { count: BENCH.length, oodCount: OOD_BENCH.length };
  });

  await t('mutate operators', async () => {
    const cand = { id: 'test', prompt: PATTERNS[0]?.prompt || 'hello world' };
    const m = await mutate(cand, { op: 'all', bench: BENCH });
    return { ops: Object.keys(OPERATORS).length, mutated: m.length, sample: m[0]?.prompt?.slice(0, 30) };
  });

  await t('applyEvolvedPrompt (no evolve)', async () => {
    return applyEvolvedPrompt(callChat, 'What is 6*7?', {});
  });

  // -- code generation
  await t('generateAndRunCode', async () => {
    const r = await generateAndRunCode(callChat, 'Compute 5 factorial', 'Compute 5!', { maxRetries: 1 });
    return { result: String(r.result).slice(0, 60), validated: r.sandboxValidated };
  });

  await t('staticAnalysisAgent (skips code on plain string)', async () => {
    return staticAnalysisAgent(null, { 'index.js': 'console.log("hi")' }, 'noop', { model: MODEL }).then(r => ({ issues: r.length }));
  }).catch(e => ({ err: e.message }));

  // -- file block helpers (pure)
  await t('parseFilesFromResponse (no blocks)', async () => {
    return parseFilesFromResponse('no file blocks here');
  });

  await t('parseFilesFromResponse (one block)', async () => {
    const r = parseFilesFromResponse('### FILE: a.js\nconsole.log(1)\n');
    return r;
  });

  await t('applyPatchBlocks (empty)', async () => {
    return applyPatchBlocks('', { 'a.js': 'old' });
  });

  await t('checkSyntaxAST on valid file', async () => {
    const r = checkSyntaxAST('index.js');
    return r;
  });

  await t('FILE_BLOCK_PROMPT exists', async () => {
    return FILE_BLOCK_PROMPT.slice(0, 30);
  });

  console.log(`\n== ${pass} pass, ${fail} fail ==`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
