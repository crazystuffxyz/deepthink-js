// scripts/unit/concurrency.test.js
// logic-level tests for the AdaptiveConcurrency exponential-search
// discovery — no server, synthetic batches.
//   node scripts/unit/concurrency.test.js
// exits 0 when all scenarios pass, 1 otherwise.

import { AdaptiveConcurrency, saveConcurrencyCache } from '../../dist/thinking/concurrency.js';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// drive the scaler with synthetic batches until it settles or the loop
// budget dies. bound = concurrency ceiling of the fake endpoint; a batch
// of L calls gets rate-limited only when L > bound.
async function drive(sc, bound, { contention = 1 } = {}) {
  for (let i = 0; i < 300; i++) {
    const total = sc.current * contention;
    const excess = Math.max(0, total - bound);
    // excess rejections spread across the instances' calls
    const rl = contention > 1 ? Math.round(excess / contention) : excess;
    const calls = Math.max(sc.current, 1);
    sc.onBatch({ calls, errors: rl, rateLimited: rl, timeouts: 0, avgLatencyMs: 100, p95LatencyMs: 120 });
    await sc.waitForDispatch(); // blocks through any backoff; canDispatch restores state
    if (sc.state === 'stable') return;
  }
  throw new Error('drive loop never settled (state=' + sc.state + ' current=' + sc.current + ')');
}

const ev = (name) => { const out = []; return [out, (m) => out.push(m)]; };

// ---- 1: exponential search finds an unknown ceiling above 10 ----
{
  const [events, onEvent] = ev('solo');
  const sc = new AdaptiveConcurrency({ model: 'unit-solo-1', probeCalls: 4, max: 32, onEvent });
  await drive(sc, 10);
  ok('solo: settles at the true bound (10)', sc.current === 10, `got ${sc.current}`);
  ok('solo: discovered via a 429 (firstBad=11, adjacent to lastGood)', sc.firstBad === 11, `firstBad=${sc.firstBad}`);
  ok('solo: doubled exponentially before the 429', events.some((m) => m.includes('doubled to 16')), events.slice(-4).join(' | '));
  ok('solo: binary-searched (midpoint probes logged)', events.some((m) => m.includes('settling: testing 12')), 'no 12 probe');
  ok('solo: stable state', sc.state === 'stable', sc.state);
}

// ---- 2: warm start from cache still probes up to the real ceiling ----
{
  saveConcurrencyCache({ 'unit-warm-1': { level: 6, when: Date.now() } });
  const sc = new AdaptiveConcurrency({ model: 'unit-warm-1', probeCalls: 4, max: 32 });
  ok('warm: starts at the cached level (6)', sc.current === 6, `got ${sc.current}`);
  await drive(sc, 10);
  ok('warm: re-discovers the true ceiling (10) despite the stale cache', sc.current === 10, `got ${sc.current}`);
}

// ---- 3: two instances sharing the wire (benchmark queue 2) ----
// each instance can only push so far before the OTHER's calls push the
// total past the bound — both converge near bound/2.
{
  const a = new AdaptiveConcurrency({ model: 'unit-cont-1', probeCalls: 4, max: 32 });
  const b = new AdaptiveConcurrency({ model: 'unit-cont-2', probeCalls: 4, max: 32 });
  for (let i = 0; i < 300 && !(a.state === 'stable' && b.state === 'stable'); i++) {
    for (const sc of [a, b]) await sc.waitForDispatch();
    const total = a.current + b.current;
    for (const sc of [a, b]) {
      const excess = Math.max(0, total - 10);
      const rl = Math.round(excess * sc.current / Math.max(1, total));
      sc.onBatch({ calls: sc.current, errors: rl, rateLimited: rl, timeouts: 0, avgLatencyMs: 100, p95LatencyMs: 120 });
    }
  }
  ok('contention: both instances settle near bound/2 (≈5)', a.current <= 6 && b.current <= 6 && a.current >= 4 && b.current >= 4, `a=${a.current} b=${b.current}`);
}

// ---- 4: bound lowered while stable (server shrank its concurrency) ----
{
  const sc = new AdaptiveConcurrency({ model: 'unit-lower-1', probeCalls: 4, max: 32 });
  await drive(sc, 10);
  ok('lower: settled at 10 first', sc.current === 10, `got ${sc.current}`);
  await drive(sc, 8);
  ok('lower: re-converges to the new bound (8)', sc.current === 8, `got ${sc.current}`);
}

// ---- 5: timeout storms still halve + back off (not a bound signal) ----
{
  const sc = new AdaptiveConcurrency({ model: 'unit-tmo-1', probeCalls: 2, max: 32 });
  sc.onBatch({ calls: 8, errors: 4, rateLimited: 0, timeouts: 4, avgLatencyMs: 100, p95LatencyMs: 120 });
  ok('timeout: halved (2→1) and entered backoff', sc.state === 'backoff' && sc.current === 1, `state=${sc.state} cur=${sc.current}`);
  await sc.waitForDispatch();
  sc.canDispatch(); // the next dispatch restores the pre-backoff state
  ok('timeout: resumes discovering after backoff', sc.state === 'discovering', sc.state);
}

// ---- 6: cached level already above the bound (bound dropped while off) ----
{
  saveConcurrencyCache({ 'unit-over-1': { level: 6, when: Date.now() } });
  const sc = new AdaptiveConcurrency({ model: 'unit-over-1', probeCalls: 4, max: 32 });
  await drive(sc, 4);
  ok('over: starts above the bound but settles back at 4', sc.current === 4, `got ${sc.current}`);
}

// ---- 7: single-call onError with a raw 429 body enters discovery ----
{
  const sc = new AdaptiveConcurrency({ model: 'unit-err-1', probeCalls: 4, max: 32 });
  sc.onError(new Error('429 too many requests'));
  ok('onError: 429 marks firstBad=2 (the bound) and drains briefly', sc.firstBad === 2 && sc.state === 'backoff', `firstBad=${sc.firstBad} state=${sc.state}`);
  await sc.waitForDispatch();
  sc.canDispatch();
  ok('onError: resumes in settling (binary search below 2)', sc.state === 'settling' && sc.current === 1, `state=${sc.state} cur=${sc.current}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
