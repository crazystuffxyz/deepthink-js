// test_sandbox.js — runJSSandbox and runPythonSandbox. No LLM needed.
'use strict';

import { runJSSandbox, runPythonSandbox, PYTHON_BIN, compareResults } from '../thinking/codeGenerator.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }

(async () => {
  // JS: simple print
  const out1 = await runJSSandbox('console.log(2 + 2);');
  ok(out1 === '4', 'js print 2+2 -> ' + JSON.stringify(out1));

  // JS: BigInt
  const out2 = await runJSSandbox('console.log((12345678901234567890n).toString());');
  ok(out2 === '12345678901234567890', 'js BigInt -> ' + JSON.stringify(out2));

  // JS: sandbox returns output for valid code
  const outFs = await runJSSandbox("const fs = require('fs'); console.log(typeof fs.readFileSync);");
  ok(outFs === 'function', 'js sandbox returns output for require call');

  // JS: crash on bad code
  let crashed = false;
  try {
    await runJSSandbox('process.exit(2);');
  } catch { crashed = true; }
  ok(crashed, 'js non-zero exit rejected');

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
