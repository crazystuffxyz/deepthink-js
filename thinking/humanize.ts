// thinking/humanize.ts
// iterative humanize -> AI-check -> fix -> re-humanize until the detector
// says 0% AI-ness. every pass is a separate LLM call so the loop is
// observable and each stage can be tuned independently.
//
// stages per iteration:
//   1. humanize  — rewrite with a human voice (vary sentence length, kill
//      AI-tell words, add concrete texture, break perfect parallelism)
//   2. integrity — AI compares original vs rewrite: grammar broken? content
//      lost? facts/numbers/names changed? returns issues
//   3. fix       — targeted replacements for the issues (no full rewrite)
//   4. detect    — AI judge scores AI-ness 0-100 and lists the tells
// loop until score <= threshold (default 0) or maxIterations.
//
// claim preservation is enforced structurally: every number, name, and date
// in the original must survive into the final text (checked by the integrity
// stage AND by a local regex sweep as a backstop).

import { tryParseJsonSafe as parseJsonSafe } from '../parse/json.js';
import { z } from 'zod';

const IntegritySchema = z.object({
  issues: z.array(z.object({
    type: z.string().optional(),
    original: z.string().optional(),
    rewritten: z.string().optional(),
    fix: z.string().optional(),
  })).optional(),
  ok: z.boolean().optional(),
});

const DetectorSchema = z.object({
  aiScore: z.number().optional(),
  tells: z.array(z.string()).optional(),
  verdict: z.string().optional(),
});

const AI_TELL_WORDS = [
  'delve', 'tapestry', 'landscape', 'leverage', 'utilize', 'furthermore', 'moreover',
  'additionally', 'in conclusion', 'it is important to note', 'it is worth noting',
  'comprehensive', 'robust', 'seamless', 'cutting-edge', 'state-of-the-art',
  'in today\'s fast-paced', 'navigate the complexities', 'play a pivotal role',
  'a testament to', 'underscore', 'showcase', 'foster', 'holistic', 'synergy',
  'paradigm', 'multifaceted', 'intricate', 'meticulous', 'unprecedented',
  'revolutionize', 'transformative', 'empower', 'streamline', 'optimize',
];

const HUMANIZE_SYS = `You are a human writer who happens to be excellent at their craft. Rewrite the given text so it reads as written by a specific, knowledgeable human — not an AI.

RULES:
1. Vary sentence length sharply: some sentences 4 words, some 40.
2. Remove every AI-tell word and phrase (delve, tapestry, leverage, furthermore, moreover, additionally, in conclusion, it is important to note, comprehensive, robust, seamless, cutting-edge, state-of-the-art, pivotal, testament, underscore, showcase, foster, holistic, synergy, paradigm, multifaceted, intricate, meticulous, unprecedented, revolutionize, transformative, empower, streamline, optimize, navigate the complexities, play a pivotal role, in today's fast-paced world).
3. Break perfect parallelism. Do not start consecutive sentences with the same word.
4. Use concrete specifics over abstractions. Where the text has a number, keep the number EXACTLY.
5. Write like a person with opinions and a voice: contractions are fine, occasional short punchy sentences are fine, mild informality is fine.
6. Keep the structure the text needs (headings, lists) but make the prose inside feel human.
7. NEVER change facts, numbers, names, dates, or citations. Every [Source N] tag must survive verbatim.
8. Do not add new claims. Do not remove claims.
9. Output ONLY the rewritten text. No preamble, no explanation, no "here is".`;

const INTEGRITY_SYS = `You are a meticulous copy editor. Compare the ORIGINAL text with the REWRITE and find every way the rewrite damaged it.

CHECK FOR:
1. Content loss — claims, sections, or details present in the original but missing in the rewrite.
2. Fact drift — numbers, names, dates, or figures that changed (even slightly).
3. Grammar errors — broken sentences, wrong words, typos introduced by the rewrite.
4. Citation damage — [Source N] tags missing, renumbered, or altered.
5. Meaning change — the rewrite says something different from the original.

Output ONLY valid JSON — no markdown fences, no prose:
{"issues": [{"type": "content_loss|fact_drift|grammar|citation_damage|meaning_change", "original": "exact original text", "rewritten": "exact rewritten text", "fix": "the exact replacement text that repairs it"}], "ok": true|false}
If the rewrite is fine, output {"issues": [], "ok": true}.`;

const FIX_SYS = `You are a careful editor. Apply ONLY the listed fixes to the text. Do not rewrite anything else. Do not change style, tone, or structure beyond the fixes. Preserve every [Source N] tag.

Output ONLY the complete corrected text. No preamble, no explanation.`;

const DETECTOR_SYS = `You are an AI-text detector with a sharp eye. Judge how likely the given text was written by an AI.

SIGNALS OF AI WRITING:
- Uniform sentence length (every sentence 15-25 words)
- Perfect grammar and parallelism everywhere
- AI-tell words: delve, tapestry, leverage, furthermore, moreover, additionally, in conclusion, it is important to note, comprehensive, robust, seamless, cutting-edge, state-of-the-art, pivotal, testament, underscore, showcase, foster, holistic, synergy, paradigm, multifaceted, intricate, meticulous, unprecedented, revolutionize, transformative, empower, streamline, optimize
- Bullet-point-heavy structure with parallel phrasing
- No contractions, no voice, no personality
- Hedging everywhere ("it is worth noting", "arguably", "in many ways")
- Em-dash overuse, "Not only... but also" constructions

SIGNALS OF HUMAN WRITING:
- Varied sentence lengths (some very short, some long)
- Contractions, opinions, a distinct voice
- Occasional informality or idiosyncrasy
- Concrete details and specifics
- Imperfect but natural rhythm

Output ONLY valid JSON — no markdown fences, no prose:
{"aiScore": 0-100, "tells": ["specific phrase or pattern that gave it away"], "verdict": "human|ai"}
aiScore 0 = reads 100% human. aiScore 100 = reads 100% AI.`;

function extractClaims(text: string): string[] {
  // numbers, percentages, dollar amounts, years, and [Source N] tags
  const out = new Set<string>();
  const patterns = [
    /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, // 1,000,000
    /\b\d+(?:\.\d+)?%/g,                 // 12.5%, 42%
    /\b\d+(?:\.\d+)?\b/g,                // 42, 3.5, 2024
    /\$\d+(?:\.\d+)?[bm]?\b/gi,          // $12.8b
    /\[Source \d+\]/g,                   // [Source 3]
  ];
  for (const p of patterns) {
    for (const m of text.match(p) || []) out.add(m);
  }
  return [...out];
}

function claimsSurvived(original: string, rewritten: string): string[] {
  const missing: string[] = [];
  for (const c of extractClaims(original)) {
    if (!rewritten.includes(c)) missing.push(c);
  }
  return missing;
}

export async function humanizeText(callChat: any, text: string, opts: any = {}): Promise<any> {
  const maxIterations = opts.maxIterations ?? 12;
  const threshold = opts.detectorThreshold ?? 0;
  const log = opts.log || (() => {});
  let current = String(text ?? '');
  // the References section is metadata (titles, years, URLs) — the
  // humanizer must never touch it. run 10: a rewrite dropped the whole
  // References section and the integrity check only catches individual
  // claims, so the report shipped without sources. split it off, humanize
  // the body only, re-attach at the end.
  const refIdx = current.search(/\n---\n## References|\n## References/i);
  const refTail = refIdx > -1 ? current.slice(refIdx) : '';
  if (refTail) current = current.slice(0, refIdx);
  const history: any[] = [];

  for (let iter = 1; iter <= maxIterations; iter++) {
    log({ level: 'info', msg: `[humanize] iteration ${iter}/${maxIterations} — humanize pass`, source: 'humanize', ts: Date.now() });
    // feedback loop: the previous detector pass told us exactly what reads
    // as AI — hand those tells to the humanizer so it targets them instead
    // of guessing blind every iteration.
    const lastDet = history.at(-1);
    const tellsNote = lastDet && lastDet.tells?.length
      ? `\n\nThe detector flagged these tells in the previous pass — eliminate them specifically:\n${lastDet.tells.map((t: string) => `- ${t}`).join('\n')}`
      : '';
    const hR = await callChat(
      [{ role: 'system', content: HUMANIZE_SYS }, { role: 'user', content: current + tellsNote }],
      false, null, { ...opts, think: false, samplingProfile: 'creative' });
    let rewritten = (hR.content || '').trim();
    if (!rewritten || rewritten.length < current.length * 0.3) {
      log({ level: 'warn', msg: '[humanize] rewrite suspiciously short — keeping original', source: 'humanize', ts: Date.now() });
      rewritten = current;
    }

    // integrity check: did the humanizer ruin anything?
    log({ level: 'info', msg: `[humanize] iteration ${iter} — integrity check`, source: 'humanize', ts: Date.now() });
    const iR = await callChat(
      [{ role: 'system', content: INTEGRITY_SYS }, { role: 'user', content: `ORIGINAL:\n${current}\n\n---\n\nREWRITE:\n${rewritten}` }],
      false, null, { ...opts, think: false, samplingProfile: 'json' });
    const integrity = parseJsonSafe(iR.content || '', IntegritySchema) || { issues: [], ok: true };
    const issues = Array.isArray(integrity.issues) ? integrity.issues : [];

    // local backstop: claims must survive
    const missingClaims = claimsSurvived(current, rewritten);
    if (missingClaims.length) {
      log({ level: 'warn', msg: `[humanize] ${missingClaims.length} claims lost in rewrite: ${missingClaims.slice(0, 5).join(', ')}`, source: 'humanize', ts: Date.now() });
      issues.push({ type: 'fact_drift', original: missingClaims.join(', '), rewritten: '(missing)', fix: `Restore these exact values into the text: ${missingClaims.join(', ')}` });
    }

    if (issues.length) {
      log({ level: 'info', msg: `[humanize] iteration ${iter} — fixing ${issues.length} issues`, source: 'humanize', ts: Date.now() });
      const issuesList = issues.map((iss: any, i: number) => `ISSUE ${i + 1} [${iss.type}]:\n  Original: "${iss.original || ''}"\n  Rewritten: "${iss.rewritten || ''}"\n  Fix: ${iss.fix || 'Repair as described'}`).join('\n\n');
      const fR = await callChat(
        [{ role: 'system', content: FIX_SYS }, { role: 'user', content: `ISSUES TO FIX:\n${issuesList}\n\n---\n\nTEXT:\n${rewritten}` }],
        false, null, { ...opts, think: false, samplingProfile: 'creative' });
      const fixed = (fR.content || '').trim();
      if (fixed.length >= rewritten.length * 0.5) rewritten = fixed;
    }

    // detector
    log({ level: 'info', msg: `[humanize] iteration ${iter} — detector`, source: 'humanize', ts: Date.now() });
    const dR = await callChat(
      [{ role: 'system', content: DETECTOR_SYS }, { role: 'user', content: rewritten }],
      false, null, { ...opts, think: false, samplingProfile: 'json' });
    const det = parseJsonSafe(dR.content || '', DetectorSchema) || { aiScore: 100, tells: [], verdict: 'ai' };
    // careful: Number(0) || 100 would turn a legit 0 into 100 — check null, not falsy
    const score = Math.max(0, Math.min(100, det.aiScore == null ? 100 : Number(det.aiScore)));
    history.push({ iteration: iter, aiScore: score, tells: det.tells || [], issuesFixed: issues.length });
    log({ level: 'info', msg: `[humanize] iteration ${iter} — detector score: ${score} (verdict: ${det.verdict})`, source: 'humanize', ts: Date.now() });

    current = rewritten;
    if (score <= threshold) {
      log({ level: 'success', msg: `[humanize] detector at ${score} <= ${threshold} — done after ${iter} iterations`, source: 'humanize', ts: Date.now() });
      return { text: current + refTail, iterations: iter, finalScore: score, history, ok: true };
    }
    // plateau guard: if the score stopped improving two passes in a row,
    // more rewrites just burn calls — the tells feedback has converged.
    const prev = history.at(-2)?.aiScore;
    const prev2 = history.at(-3)?.aiScore;
    if (prev != null && prev2 != null && score >= prev && prev >= prev2) {
      log({ level: 'warn', msg: `[humanize] score plateaued (${prev2} -> ${prev} -> ${score}) — stopping early`, source: 'humanize', ts: Date.now() });
      return { text: current + refTail, iterations: iter, finalScore: score, history, ok: score <= threshold };
    }
  }
  log({ level: 'warn', msg: `[humanize] hit max iterations (${maxIterations}) — final score ${history.at(-1)?.aiScore ?? '?'}`, source: 'humanize', ts: Date.now() });
  return { text: current + refTail, iterations: maxIterations, finalScore: history.at(-1)?.aiScore ?? 100, history, ok: history.at(-1)?.aiScore <= threshold };
}

export { AI_TELL_WORDS, extractClaims, claimsSurvived };
