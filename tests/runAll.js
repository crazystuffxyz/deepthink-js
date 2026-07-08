// test runner — runs every test_*.js file in this folder
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const files = fs.readdirSync(__dirname)
  .filter(f => f.startsWith('test_') && f.endsWith('.js'))
  .sort();

if (!files.length) {
  console.error('No test_*.js files found in', __dirname);
  process.exit(1);
}

const env = { ...process.env, DEEPTHINK_TEST_MODEL: process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud' };

async function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: 'inherit' });
    proc.on('close', (code) => {
      const ms = Date.now() - t0;
      resolve({ file, code, ms });
    });
    proc.on('error', (e) => resolve({ file, code: 1, ms: Date.now() - t0, error: e.message }));
  });
}

const results = [];
for (const f of files) {
  console.log(`\n========== ${f} ==========`);
  const r = await runOne(f);
  results.push(r);
}

console.log('\n========== TEST SUMMARY ==========');
let pass = 0, fail = 0;
for (const r of results) {
  const status = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code === 0) pass++; else fail++;
  console.log(`  [${status}] ${r.file} (${r.ms}ms)`);
}
console.log(`\nTotal: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
