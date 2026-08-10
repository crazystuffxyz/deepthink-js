// test_images.js — unit tests for multimodal plumbing
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { loadImages, describeImages, looksVisionCapable } from '../dist/thinking/images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

console.log('test_images');

await test('looksVisionCapable: vision models detected', () => {
  for (const m of ['llava:7b', 'gemma3:12b', 'qwen2-vl:7b', 'gpt-4o', 'claude-sonnet-5', 'gemini-2.0-flash', 'pixtral-12b']) {
    if (!looksVisionCapable(m)) throw new Error(`${m} should be vision-capable`);
  }
});

await test('looksVisionCapable: text-only models rejected', () => {
  for (const m of ['gemma4:31b-cloud', 'deepseek-v4-flash:0731-cloud', 'llama3.1:8b', 'mistral:7b']) {
    if (looksVisionCapable(m)) throw new Error(`${m} should NOT be vision-capable`);
  }
});

await test('loadImages: data URI passes through untouched', async () => {
  const uri = 'data:image/png;base64,AAAA';
  const out = await loadImages([uri]);
  if (out[0] !== uri) throw new Error('data URI should pass through');
});

await test('loadImages: bare base64 becomes jpeg data URI', async () => {
  const out = await loadImages(['aGVsbG8=']);
  if (out[0] !== 'data:image/jpeg;base64,aGVsbG8=') throw new Error(`got ${out[0]}`);
});

await test('loadImages: file path becomes data URI with right mime', async () => {
  const png = path.join(__dirname, 'fixtures', 'tiny.png');
  fs.mkdirSync(path.dirname(png), { recursive: true });
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const out = await loadImages([png]);
  if (!out[0].startsWith('data:image/png;base64,')) throw new Error(`got ${out[0].slice(0, 30)}`);
  fs.rmSync(path.dirname(png), { recursive: true, force: true });
});

await test('loadImages: object form with base64 field', async () => {
  const out = await loadImages([{ base64: 'eA==' }]);
  if (out[0] !== 'data:image/jpeg;base64,eA==') throw new Error(`got ${out[0]}`);
});

await test('loadImages: missing file skipped silently', async () => {
  const out = await loadImages(['C:/definitely/not/here.png']);
  if (out.length !== 0) throw new Error('should skip missing file');
});

await test('describeImages: vision model transcribes, one block per image', async () => {
  const callChat = async (msgs, stream, cb, opts) => {
    const user = msgs[1];
    if (!user.images || !user.images.length) throw new Error('image not attached');
    if (!user.images[0].startsWith('data:image/')) throw new Error('not a data URI');
    return { content: 'A chart showing revenue rising from 10 to 20.' };
  };
  const out = await describeImages(callChat, ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'], {});
  if (!out.includes('[Image 1]') || !out.includes('[Image 2]')) throw new Error('missing image blocks');
  if (!out.includes('revenue')) throw new Error('description missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
