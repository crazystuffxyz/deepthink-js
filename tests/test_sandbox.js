// test_sandbox.js — runJSSandbox and runPythonSandbox. No LLM needed.
'use strict';

import { runJSSandbox, runPythonSandbox, PYTHON_BIN, compareResults } from '../dist/codeGenerator/index.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }

(async () => {
  // JS: simple print
  const out1 = await runJSSandbox('console.log(2 + 2);');
  ok(out1 === '4', 'js print 2+2 -> ' + JSON.stringify(out1));

  // JS: BigInt
  const out2 = await runJSSandbox('console.log((12345678901234567890n).toString());');
  ok(out2 === '12345678901234567890', 'js BigInt -> ' + JSON.stringify(out2));

  // JS: sandbox returns output for valid code
  const outFs = await runJSSandbox("console.log(2 + 3);");
  ok(outFs === '5', 'js sandbox returns output for console.log call');

  // JS: blocked modules
  let blocked = false;
  try {
    await runJSSandbox("require('fs')");
  } catch { blocked = true; }
  ok(blocked, 'js blocks require(fs)');

  // JS: crash on bad code
  let crashed = false;
  try {
    await runJSSandbox('throw new Error("nope");');
  } catch { crashed = true; }
  ok(crashed, 'js throws bubble out');

  // JS: timeout
  let timedOut = false;
  try {
    await runJSSandbox('while (true) {}');
  } catch { timedOut = true; }
  ok(timedOut, 'js infinite loop times out');

  // JS: memory limit
  let oom = false;
  try {
    await runJSSandbox('const a=[]; while(true) a.push(new Array(1000000).fill(0));');
  } catch { oom = true; }
  ok(oom, 'js memory growth disposed');

  if (PYTHON_BIN) {
    const p1 = await runPythonSandbox('print(2 ** 10)');
    ok(p1 === '1024', 'py 2**10 -> ' + JSON.stringify(p1));
  } else {
    console.log('  (python not installed, skipping python sandbox tests)');
  }

  // compareResults
  ok(compareResults('4', 4) === true, 'compareResults 4 == 4');
  ok(compareResults('1/2', '0.5') === true, 'compareResults 1/2 == 0.5');
  ok(compareResults('foo', 'bar') === false, 'compareResults foo != bar');

  console.log('codeGenerator sandbox: ALL PASS');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
