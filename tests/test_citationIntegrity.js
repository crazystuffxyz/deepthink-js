// test_citationIntegrity.js — unit tests for citation preservation
'use strict';

import { extractSourceTags, checkCitationIntegrity, checkReferencesSection, restoreCitations, enforceCitations } from '../dist/thinking/citationIntegrity.js';

let pass = 0, fail = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label}\n      ${e.message}`); fail++; }
}

console.log('test_citationIntegrity');

await test('extractSourceTags finds all tags in order', () => {
  const tags = extractSourceTags('A [Source 1] B [Source 2] C [Source 1]');
  if (tags.join(',') !== '[Source 1],[Source 2],[Source 1]') throw new Error(`got ${tags.join(',')}`);
});

await test('extractSourceTags: no tags → empty', () => {
  if (extractSourceTags('no citations here').length) throw new Error('should be empty');
});

await test('checkCitationIntegrity: missing + orphan detection', () => {
  const r = checkCitationIntegrity('Claim [Source 1] and [Source 3] and [Source 9]', 3);
  if (r.missing.join(',') !== '2') throw new Error(`missing should be [2], got ${r.missing}`);
  if (r.orphans.join(',') !== '[Source 9]') throw new Error(`orphans should be [Source 9], got ${r.orphans}`);
  if (!r.cited.has(1) || !r.cited.has(3)) throw new Error('cited set wrong');
});

await test('checkCitationIntegrity: all cited → no missing', () => {
  const r = checkCitationIntegrity('[Source 1] [Source 2] [Source 3]', 3);
  if (r.missing.length) throw new Error(`got missing ${r.missing}`);
  if (r.orphans.length) throw new Error(`got orphans ${r.orphans}`);
});

await test('checkReferencesSection: complete refs pass', () => {
  const report = 'Body text.\n\n## References\n[1] Alpha, 2024\n[2] Beta, 2025';
  const r = checkReferencesSection(report, 2);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
});

await test('checkReferencesSection: missing ref entry flagged', () => {
  const report = 'Body text.\n\n## References\n[1] Alpha, 2024';
  const r = checkReferencesSection(report, 2);
  if (r.ok) throw new Error('expected not ok');
  if (r.missingRefs.join(',') !== '2') throw new Error(`got ${r.missingRefs}`);
});

await test('restoreCitations: inserts missing tags', async () => {
  const callChat = async (msgs) => {
    const user = String(msgs[1]?.content || '');
    if (!user.includes('MISSING SOURCES')) throw new Error('wrong prompt shape');
    return { content: 'Revenue grew 12% [Source 2] in 2024. [Source 1] backs the moat claim.' };
  };
  const claims = new Map([[1, ['wide moat']], [2, ['revenue grew 12%']]]);
  const out = await restoreCitations(callChat, 'Revenue grew 12% in 2024. Wide moat.', [1, 2], claims, {});
  if (!out.includes('[Source 1]') || !out.includes('[Source 2]')) throw new Error(`tags missing: ${out}`);
});

await test('restoreCitations: degenerate output rejected (keeps original)', async () => {
  const callChat = async () => ({ content: 'x' }); // too short → rejected
  const out = await restoreCitations(callChat, 'Revenue grew 12% in 2024.', [1], new Map([[1, ['x']]]), {});
  if (out !== 'Revenue grew 12% in 2024.') throw new Error('should keep original');
});

await test('enforceCitations: full loop restores and re-checks', async () => {
  let calls = 0;
  const callChat = async (msgs) => {
    calls++;
    const user = String(msgs[1]?.content || '');
    if (user.includes('MISSING SOURCES')) {
      return { content: 'Revenue grew 12% [Source 2] in 2024. Moat [Source 1].' };
    }
    return { content: 'Revenue grew 12% [Source 2] in 2024. Moat [Source 1].' };
  };
  const claims = new Map([[1, ['wide moat']], [2, ['revenue grew 12%']]]);
  const r = await enforceCitations(callChat, 'Revenue grew 12% in 2024. Wide moat.', 2, claims, {});
  if (r.restored.join(',') !== '1,2') throw new Error(`restored should be 1,2 got ${r.restored}`);
  if (r.orphans.length) throw new Error(`orphans: ${r.orphans}`);
  const after = checkCitationIntegrity(r.report, 2);
  if (after.missing.length) throw new Error(`still missing ${after.missing}`);
});

await test('enforceCitations: nothing missing → no LLM calls', async () => {
  let calls = 0;
  const callChat = async () => { calls++; return { content: '' }; };
  const r = await enforceCitations(callChat, '[Source 1] [Source 2]', 2, new Map(), {});
  if (calls !== 0) throw new Error(`expected 0 calls, got ${calls}`);
  if (r.restored.length) throw new Error('nothing should be restored');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
