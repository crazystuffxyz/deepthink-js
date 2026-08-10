// scripts/benchmarks/verifyMulti.js
// independent gold verification for freshMulti.jsonl — every answer is
// computed from first principles here, NOT taken from the problem author's
// head. run: node scripts/benchmarks/verifyMulti.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', '..', 'benchmarks', 'data', 'freshMulti.jsonl');
const problems = fs.readFileSync(DATA, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const results = {};

// m01: bayes, unequal priors
{
  // P(RR|A) = C(2,2)/C(5,2), P(RR|B) = C(4,2)/C(6,2), prior A = 2/3
  const pRR_A = 1 / 10, pRR_B = 6 / 15;
  const num = pRR_A * (2 / 3), den = num + pRR_B * (1 / 3);
  results.m01 = num / den; // expect 1/3
}

// m02: x + 1/x = 3 -> x^2 + 1/x^2 = 7 -> x^4 + 1/x^4 = 47
{
  const s = 3;
  const s2 = s * s - 2, s4 = s2 * s2 - 2;
  results.m02 = s4; // 47
}

// m03: optimal stopping, up to 4 rolls
{
  let E = 3.5; // 1 roll left: expected value of the roll
  for (let rolls = 2; rolls <= 4; rolls++) {
    // stop if roll >= E, else continue
    let sum = 0;
    for (let d = 1; d <= 6; d++) sum += Math.max(d, E);
    E = sum / 6;
  }
  results.m03 = E; // expect 14/3 = 4.6667
}

// m04: flip until 2H or 3T, P(2H first) — exact enumeration of all sequences
{
  let pH = 0;
  const walk = (h, t, p) => {
    if (h === 2) { pH += p; return; }
    if (t === 3) return;
    walk(h + 1, t, p / 2);
    walk(h, t + 1, p / 2);
  };
  walk(0, 0, 1);
  results.m04 = pH; // expect 13/16 = 0.8125
}

// m05: n^2 ≡ 1 mod 7, 1..2026
{
  let c = 0;
  for (let n = 1; n <= 2026; n++) if ((n * n) % 7 === 1) c++;
  results.m05 = c; // expect 579
}

// m06: integer sides, area 2026, min perimeter
{
  let best = Infinity;
  for (let a = 1; a * a <= 2026; a++) {
    if (2026 % a === 0) best = Math.min(best, 2 * (a + 2026 / a));
  }
  results.m06 = best; // expect 2030
}

// m07: 3^2026 mod 11
{
  let r = 1;
  for (let n = 0; n < 2026; n++) r = (r * 3) % 11;
  results.m07 = r; // expect 3
}

// m08: 2^2026 mod 2026
{
  let r = 1;
  for (let n = 0; n < 2026; n++) r = (r * 2) % 2026;
  results.m08 = r; // expect 4
}

// m09: committee 5 from 8M 6W, given >=2W, P(exactly 3W)
{
  const C = (n, k) => {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };
  const num = C(6, 3) * C(8, 2);
  const den = C(6, 2) * C(8, 3) + C(6, 3) * C(8, 2) + C(6, 4) * C(8, 1) + C(6, 5) * C(8, 0);
  results.m09 = num / den; // expect 560/1526 = 280/763
}

// m10: draw with replacement until red, max 4 draws, 3R 2B
{
  let E = 0;
  for (let d = 1; d <= 4; d++) {
    const pStop = d === 4 ? Math.pow(2 / 5, 3) : Math.pow(2 / 5, d - 1) * (3 / 5);
    E += d * pStop;
  }
  results.m10 = E; // expect 203/125 = 1.624
}

// m11: right triangle, a+b+c=24, area 24 -> c
{
  // a+b = 24-c, ab = 48, a^2+b^2 = c^2 -> (24-c)^2 - 96 = c^2 -> c = 10
  results.m11 = 10;
}

// m12: two-rule sequence
{
  const a = [0, 1, 2];
  for (let n = 3; n <= 8; n++) {
    a[n] = n % 2 === 1 ? a[n - 1] + 2 * a[n - 2] : 2 * a[n - 1] + a[n - 2];
  }
  results.m12 = a[8]; // expect 210
}

// m13: 3-digit ABC, A+B+C=18, div by 11
{
  let c = 0;
  for (let n = 100; n <= 999; n++) {
    const A = Math.floor(n / 100), B = Math.floor(n / 10) % 10, C = n % 10;
    if (A + B + C === 18 && n % 11 === 0) c++;
  }
  results.m13 = c; // expect 9
}

// m14: 4 flips, given >=2H, P(exactly 3H)
{
  let ge2 = 0, ex3 = 0;
  for (let mask = 0; mask < 16; mask++) {
    const h = (mask.toString(2).match(/1/g) || []).length;
    if (h >= 2) { ge2++; if (h === 3) ex3++; }
  }
  results.m14 = ex3 / ge2; // expect 4/11
}

// m15: 30 candies, $9.75, A=40c B=25c
{
  let ans = null;
  for (let A = 0; A <= 30; A++) {
    const B = 30 - A;
    if (40 * A + 25 * B === 975) ans = A;
  }
  results.m15 = ans; // expect 15
}

// m16: div by 4 or 6, not 12, 1..2026
{
  let c = 0;
  for (let n = 1; n <= 2026; n++) {
    if ((n % 4 === 0 || n % 6 === 0) && n % 12 !== 0) c++;
  }
  results.m16 = c; // expect 507
}

// m17: MISSISSIPPI, P's adjacent
{
  // treat PP as one unit: 10!/(4!4!) = 6300
  const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
  results.m17 = fact(10) / (fact(4) * fact(4)); // 6300
}

// m18: 4-digit distinct digits, div by 3 — brute force
{
  let c = 0;
  for (let n = 1000; n <= 9999; n++) {
    const s = String(n);
    if (new Set(s).size === 4 && n % 3 === 0) c++;
  }
  results.m18 = c; // expect 2844
}

// m19: $1000, 5% monthly, 3 years
{
  results.m19 = 1000 * Math.pow(1 + 0.05 / 12, 36); // expect 1161.47
}

// m20: roll for $10 on 6, max 3 rolls
{
  let E = 0;
  for (let d = 1; d <= 3; d++) {
    const p = Math.pow(5 / 6, d - 1) * (1 / 6);
    E += 10 * p;
  }
  results.m20 = E; // expect 910/216 = 4.213
}

// ---- report ----
// parse the option values out of the prompt and check the computed value
// matches the option at the gold index — catches gold-index errors AND
// option-value errors
const frac = (s) => {
  const m = s.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return Number(m[1]) / Number(m[2]);
  return Number(s.replace(/[$,]/g, ''));
};
let allOk = true;
for (const p of problems) {
  const opts = p.prompt.split('\n').slice(1).map((l) => l.replace(/^\d+\)\s*/, ''));
  const goldVal = frac(opts[p.reference - 1]);
  const got = results[p.id];
  const ok = Math.abs(got - goldVal) < 0.01; // 0.01: money options are rounded to cents
  if (!ok) allOk = false;
  console.log(`${p.id}: computed=${got} goldOpt=${p.reference} (${opts[p.reference - 1]}) ${ok ? 'OK' : 'MISMATCH'}`);
}
console.log(allOk ? '\nALL 20 GOLDS VERIFIED' : '\nMISMATCHES FOUND — fix golds before running');
process.exit(allOk ? 0 : 1);
