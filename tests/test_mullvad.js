// test_mullvad.js — sanitizeResultLink regression tests (run 23: trailing
// %20 on a searxng result link fetched the wrong page and killed the price
// recovery)
import { sanitizeResultLink } from '../dist/internet/mullvadLetaClient.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n      ${e.message}`); }
}

await test('trailing %20 stripped', () => {
  const out = sanitizeResultLink('https://www.investing.com/equities/nvidia-corp%20');
  if (out !== 'https://www.investing.com/equities/nvidia-corp') throw new Error(`got ${out}`);
});

await test('trailing + stripped', () => {
  const out = sanitizeResultLink('https://example.com/page+');
  if (out !== 'https://example.com/page') throw new Error(`got ${out}`);
});

await test('multiple encoded spaces stripped', () => {
  const out = sanitizeResultLink('https://example.com/a%20%20%20');
  if (out !== 'https://example.com/a') throw new Error(`got ${out}`);
});

await test('clean url untouched', () => {
  const out = sanitizeResultLink('https://example.com/page?q=1%202');
  if (out !== 'https://example.com/page?q=1%202') throw new Error(`got ${out}`);
});

await test('null/undefined safe', () => {
  if (sanitizeResultLink(null) !== '') throw new Error('null not handled');
  if (sanitizeResultLink(undefined) !== '') throw new Error('undefined not handled');
});

console.log(`\nmullvad: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
