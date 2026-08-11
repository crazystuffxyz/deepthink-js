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

// plateau escalation: when the tells feedback converges above 0, the normal
// humanizer has run out of moves — one radical persona rewrite transplants a
// completely different register (run 14: stuck at 15% with the standard
// prompt). if the radical pass scores better, the loop keeps going.
const RADICAL_SYS = `You are a specific human professional — a senior analyst at a boutique research firm writing a client memo at the end of a long day. Rewrite the text completely in your own voice, as if you typed it yourself at your desk.

RULES:
1. Write like you talk: contractions, run-ons, fragments, parenthetical asides. Real people do not write in perfect paragraphs.
2. Vary sentence length violently — some sentences are 3 words, some are 50.
3. Kill every trace of AI register: no "furthermore", no "in conclusion", no "it is important to note", no em-dash pairs, no "Not only... but also", no bullet-point parallelism, no hedging.
4. Use concrete, specific language. Where the text has a number, keep the number EXACTLY.
5. Keep the structure the text needs (headings, lists) but make the prose inside feel like a person typed it.
6. NEVER change facts, numbers, names, dates, or citations. Every [Source N] tag must survive verbatim.
7. Do not add new claims. Do not remove claims.
8. Output ONLY the rewritten text. No preamble, no explanation.`;

const DETECTOR_SYS = `You are an AI-text detector with a sharp eye. Judge how likely the given text was written by an AI.

IMPORTANT — STRUCTURAL ELEMENTS ARE NOT SIGNALS:
- [Source N] citation tags are REQUIRED by the report format — ignore them entirely.
- Math notation ($\\mu$, LaTeX, formulas) is REQUIRED by the report format — ignore it.
- Section headings are REQUIRED by the format — judge the prose inside them, not the headings themselves.
Judge ONLY the prose register: sentence rhythm, word choice, voice, personality.

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

SCORING RULES (run 18: the detector listed "varied sentence length", "contractions", and "distinct analyst voice" as tells and still scored 15 — those are HUMAN signals and add ZERO points):
- Start at 0. Add points ONLY for specific AI-tell phrases you can QUOTE VERBATIM from the text.
- HUMAN signals add 0 points: varied sentence length, contractions, informal phrasing, opinions, a distinct voice, staccato rhythm, non-parallel lists, idioms, conversational register, concrete details.
- AI tells are specific, quotable phrases: "delve", "furthermore", "moreover", "additionally", "in conclusion", "it is important to note", "it is worth noting", "Not only... but also", "comprehensive", "robust", "seamless", "cutting-edge", "state-of-the-art", "pivotal", "a testament to", "underscore", "showcase", "foster", "holistic", "synergy", "paradigm", "multifaceted", "intricate", "meticulous", "unprecedented", "revolutionize", "transformative", "empower", "streamline", "optimize", "navigate the complexities", "play a pivotal role", "in today's fast-paced world", em-dash pairs, perfect parallelism across 3+ consecutive bullets.
- If the text contains NONE of these verbatim, score 0. Do not invent tells. Do not penalize human voice.

Output ONLY valid JSON — no markdown fences, no prose:
{"aiScore": 0-100, "tells": ["specific phrase or pattern that gave it away"], "verdict": "human|ai"}
aiScore 0 = reads 100% human. aiScore 100 = reads 100% AI. A text whose prose reads like a specific person wrote it scores 0 — do not hedge with a floor score.`;

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
  // best-text memory: run 17 oscillated 15 -> 92 -> 85 because every rewrite
  // replaced the previous one even when it scored worse. keep the best-scoring
  // text and feed THAT back to the humanizer — the tells from the best pass are
  // the most useful feedback anyway.
  let best = { text: current, score: Infinity };

  for (let iter = 1; iter <= maxIterations; iter++) {
    log({ level: 'info', msg: `[humanize] iteration ${iter}/${maxIterations} — humanize pass`, source: 'humanize', ts: Date.now() });
    // feedback loop: the previous detector pass told us exactly what reads
    // as AI — hand those tells to the humanizer so it targets them instead
    // of guessing blind every iteration.
    const lastDet = history.at(-1);
    // when working from the best text, feed the tells from the best pass —
    // the last pass's tells describe a different (worse) text.
    const bestDet = history.find((h: any) => h.aiScore === best.score);
    const tellsSource = (current === best.text && bestDet) ? bestDet : lastDet;
    const tellsNote = tellsSource && tellsSource.tells?.length
      ? `\n\nThe detector flagged these tells in the previous pass — eliminate them specifically:\n${tellsSource.tells.map((t: string) => `- ${t}`).join('\n')}`
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

    if (score < best.score) best = { text: rewritten, score };
    current = rewritten;
    if (score <= threshold) {
      log({ level: 'success', msg: `[humanize] detector at ${score} <= ${threshold} — done after ${iter} iterations`, source: 'humanize', ts: Date.now() });
      return { text: current + refTail, iterations: iter, finalScore: score, history, ok: true };
    }
    // regression guard: if this pass scored worse than the best so far, the
    // next humanize pass starts from the best text, not the worse one.
    if (score > best.score) {
      log({ level: 'warn', msg: `[humanize] iteration ${iter} regressed (${best.score} -> ${score}) — next pass starts from best text`, source: 'humanize', ts: Date.now() });
      current = best.text;
    }
    // plateau guard: if the score stopped improving two passes in a row,
    // more rewrites just burn calls — the tells feedback has converged.
    const prev = history.at(-2)?.aiScore;
    const prev2 = history.at(-3)?.aiScore;
    if (prev != null && prev2 != null && score >= prev && prev >= prev2) {
      // escalation: one radical persona rewrite can break the register
      // plateau (run 14: stuck at 15% — the normal humanizer converged but
      // the text still read as AI). if the radical pass improves, keep
      // looping; if not, stop.
      log({ level: 'warn', msg: `[humanize] score plateaued (${prev2} -> ${prev} -> ${score}) — trying radical persona rewrite`, source: 'humanize', ts: Date.now() });
      const rR = await callChat(
        [{ role: 'system', content: RADICAL_SYS }, { role: 'user', content: current }],
        false, null, { ...opts, think: false, samplingProfile: 'creative' });
      const radical = (rR.content || '').trim();
      if (radical.length >= current.length * 0.3) {
        // the radical pass gets the same integrity treatment as a normal
        // rewrite — facts must survive the voice transplant
        const iR2 = await callChat(
          [{ role: 'system', content: INTEGRITY_SYS }, { role: 'user', content: `ORIGINAL:\n${current}\n\n---\n\nREWRITE:\n${radical}` }],
          false, null, { ...opts, think: false, samplingProfile: 'json' });
        const integrity2 = parseJsonSafe(iR2.content || '', IntegritySchema) || { issues: [], ok: true };
        const issues2 = Array.isArray(integrity2.issues) ? integrity2.issues : [];
        const missing2 = claimsSurvived(current, radical);
        if (missing2.length) issues2.push({ type: 'fact_drift', original: missing2.join(', '), rewritten: '(missing)', fix: `Restore these exact values into the text: ${missing2.join(', ')}` });
        let radicalFinal = radical;
        if (issues2.length) {
          const issuesList2 = issues2.map((iss: any, i: number) => `ISSUE ${i + 1} [${iss.type}]:\n  Original: "${iss.original || ''}"\n  Rewritten: "${iss.rewritten || ''}"\n  Fix: ${iss.fix || 'Repair as described'}`).join('\n\n');
          const fR2 = await callChat(
            [{ role: 'system', content: FIX_SYS }, { role: 'user', content: `ISSUES TO FIX:\n${issuesList2}\n\n---\n\nTEXT:\n${radical}` }],
            false, null, { ...opts, think: false, samplingProfile: 'creative' });
          const fixed2 = (fR2.content || '').trim();
          if (fixed2.length >= radical.length * 0.5) radicalFinal = fixed2;
        }
        const dR2 = await callChat(
          [{ role: 'system', content: DETECTOR_SYS }, { role: 'user', content: radicalFinal }],
          false, null, { ...opts, think: false, samplingProfile: 'json' });
        const det2 = parseJsonSafe(dR2.content || '', DetectorSchema) || { aiScore: 100, tells: [], verdict: 'ai' };
        const score2 = Math.max(0, Math.min(100, det2.aiScore == null ? 100 : Number(det2.aiScore)));
        history.push({ iteration: iter, aiScore: score2, tells: det2.tells || [], issuesFixed: issues2.length, radical: true });
        log({ level: 'info', msg: `[humanize] radical rewrite — detector score: ${score2} (verdict: ${det2.verdict})`, source: 'humanize', ts: Date.now() });
        if (score2 < score) {
          current = radicalFinal;
          if (score2 <= threshold) {
            log({ level: 'success', msg: `[humanize] radical rewrite hit ${score2} <= ${threshold} — done`, source: 'humanize', ts: Date.now() });
            return { text: current + refTail, iterations: iter, finalScore: score2, history, ok: true };
          }
          continue; // improved — keep the normal loop going
        }
        log({ level: 'warn', msg: `[humanize] radical rewrite did not improve (${score} -> ${score2}) — stopping early`, source: 'humanize', ts: Date.now() });
        return { text: current + refTail, iterations: iter, finalScore: score, history, ok: score <= threshold };
      }
      log({ level: 'warn', msg: '[humanize] radical rewrite suspiciously short — stopping early', source: 'humanize', ts: Date.now() });
      return { text: current + refTail, iterations: iter, finalScore: score, history, ok: score <= threshold };
    }
  }
  log({ level: 'warn', msg: `[humanize] hit max iterations (${maxIterations}) — final score ${history.at(-1)?.aiScore ?? '?'}`, source: 'humanize', ts: Date.now() });
  return { text: current + refTail, iterations: maxIterations, finalScore: history.at(-1)?.aiScore ?? 100, history, ok: history.at(-1)?.aiScore <= threshold };
}

export { AI_TELL_WORDS, extractClaims, claimsSurvived };
