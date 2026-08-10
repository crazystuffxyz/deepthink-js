// scripts/benchmarks/parse.js
// shared answer parser + matcher for the benchmark runners. single source of
// truth so rescore.js and freshRun.js can never drift apart.
//
// the model does not always obey "ANSWER: X" — it writes "answer is **Eating**",
// "Star is to **Galaxy**", "The next number is **Nine**". so parseAnswer
// returns a LIST of candidate answers (marker value, last number, short bolded
// segments, bracketed value) and answersMatch tries each against the gold.
// header words must match EXACTLY (whole segment) — a prefix test would
// filter out real answers like "Eating" (starts with "eat") or "First"
const HEADER_RE = /^(by|recap|reasoning|explanation|analysis|conclusion|solution|answer|step|note|source|known|goal|constraint|reconstructed|diff|sanity|alternative|strategy|working|backward|structure|consolidated|response|approach|method|verification|check|final|wait|hmm|actually|first|second|third|addition|square|interleaved|remaining|give|eat)$/i;
export function parseAnswer(text) {
  const t = String(text || '').trim();
  const out = [];
  // 1. explicit markers: "ANSWER: X", "answer: X", "answer is X", "the answer is X"
  const m = t.match(/(?:ANSWER|answer)\s*:\s*([^\n]+)/i) || t.match(/(?:the\s+)?answer\s+is\s+([^\n.]+)/i);
  if (m) {
    const mv = m[1].trim().replace(/\*\*/g, '');
    // 1b. choice-prefix: "ANSWER: 1) 63" — the leading number before ") " is
    // the choice index the model picked (gold is the 1-based index). push it
    // BEFORE the full value so it wins over the value itself
    const cp = mv.match(/^(\d+)\)\s/);
    if (cp) out.push(cp[1]);
    out.push(mv);
  }
  // 2. last number (comma-aware: "20,000" is one token, not "20" + "000")
  const nums = t.match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (nums && nums.length) out.push(nums[nums.length - 1]);
  // 3. short bolded segments (not headers, no trailing colon), last first
  const bolds = t.match(/\*\*([^*]+)\*\*/g) || [];
  const cands = bolds.map((b) => b.replace(/\*\*/g, '').trim())
    .filter((c) => c && c.length <= 25 && !HEADER_RE.test(c) && !/:$/.test(c));
  for (const c of cands.reverse()) out.push(c);
  // 4. label-value pairs: "**The missing word:** Key." — the value after a
  // bolded label is often the real answer ("Key."), and "**Final Analogy:**
  // Pencil : Eraser :: Lock : Key." contains it too. the value stops at the
  // next bold or sentence end so collapsed-newline text (csv raw) still works
  const labelRe = /\*\*([^*]+?):\*\*\s*([^*]+?)(?=\*\*|\.\s|$)/g;
  let lm;
  while ((lm = labelRe.exec(t)) !== null) {
    const val = lm[2].trim().replace(/[.。]$/, '');
    if (val && val.length <= 60) out.push(val);
  }
  // 5. last bracketed value
  const b = t.match(/\[([^\]]+)\]\s*$/);
  if (b) out.push(b[1].trim());
  // 6. choice-prefix on ANY candidate: "**1) 63**" / "1) 63" — the leading
  // number is the choice index the model picked (gold is the 1-based index).
  // the dt pipeline's final answer often has no "ANSWER:" marker, so the
  // marker-only extraction misses it — sweep the whole candidate list
  for (const c of [...out]) {
    const cp = String(c).match(/^(\d+)\)\s/);
    if (cp) out.push(cp[1]);
  }
  return out;
}

export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9./]/g, '').replace(/^0+(?=\d)/, '');
}

export function isNumeric(s) {
  return s != null && /^-?\d+(\.\d+)?$/.test(String(s).trim());
}

// "$20,000" / "20,000" / "20 000" → 20000
export function toNum(s) {
  const t = String(s).replace(/[$,\s%]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
}

export function answersMatch(got, gold) {
  if (got == null || gold == null) return false;
  const g = String(gold).trim();
  const candidates = Array.isArray(got) ? got : [got];
  for (const a0 of candidates) {
    const a = String(a0).trim();
    if (a === '') continue; // empty answer must never match anything
    if (isNumeric(g)) {
      // numeric gold: exact or tolerance only — no substring games
      const an = toNum(a);
      if (isFinite(an)) {
        const gn = parseFloat(g);
        if (g.includes('.')) { if (Math.abs(gn - an) < 0.01) return true; }
        else if (gn === an) return true;
      }
      // semantic zero: "None." / "no change" / "no missing dollar" for a 0
      // gold — substring test on normed text so explanations still match
      if (g === '0' && /none|zero|nochange|nothing|same|nomissingdollar/.test(norm(a))) return true;
      continue;
    }
    // fraction gold: n/d vs decimal, percent, or \frac{n}{d}
    const gfrac = g.match(/^(\d+)\/(\d+)$/);
    if (gfrac) {
      const gd = parseInt(gfrac[1], 10) / parseInt(gfrac[2], 10);
      const af = a.match(/^(\d+)\/(\d+)$/);
      if (af) { if (Math.abs(parseInt(af[1], 10) / parseInt(af[2], 10) - gd) < 0.01) return true; continue; }
      const latex = a.match(/\\frac\{(\d+)\}\{(\d+)\}/);
      if (latex) { if (Math.abs(parseInt(latex[1], 10) / parseInt(latex[2], 10) - gd) < 0.01) return true; continue; }
      const pct = a.match(/^(\d+(?:\.\d+)?)%$/);
      if (pct) { if (Math.abs(parseFloat(pct[1], 10) / 100 - gd) < 0.01) return true; continue; }
      if (isNumeric(a)) { if (Math.abs(parseFloat(a) - gd) < 0.01) return true; continue; }
      continue;
    }
    if (norm(a) === norm(g) || norm(a).includes(norm(g)) || norm(g).includes(norm(a))) return true;
  }
  return false;
}
