// src/mcp-server/vision.js
// iterative svg-from-image: image -> draft -> render -> score -> revise.
import { ImageUtils, SvgRenderer } from './images.js';

async function tryRender(svg, w, h) {
  // try once; if sharp rejects, wrap and retry. caller gets the final svg (possibly wrapped)
  try {
    const r = await SvgRenderer.toPngBase64(svg, { width: w, height: h });
    return { ...r, svg };
  } catch (e1) {
    const wrapped = SvgRenderer.wrap(svg, w, h);
    try {
      const r = await SvgRenderer.toPngBase64(wrapped, { width: w, height: h });
      return { ...r, svg: wrapped };
    } catch (e2) {
      return { error: e2.message || e1.message };
    }
  }
}

class VisionLoop {
  constructor(ctx) {
    this.ctx = ctx;
    this.engine = ctx.engine;
  }

  _emit(stage, data) {
    // push progress events onto the shared ring so get_event_log can surface them
    const ev = { stage, ts: Date.now(), ...data };
    try {
      this.ctx.pushLog({ channel: 'deepthink:vision-loop', data: ev, ts: Date.now() });
    } catch {
      /* swallow */
    }
  }

  // preferred -> vision-capable list -> defaultModel
  static async pickVisionModel(engine) {
    try {
      const r = await engine.listModels();
      if (r.ok && r.models && r.models.length) {
        const cap = r.models.find((m) => engine.looksVisionCapable(m.name));
        if (cap) return cap.name;
      }
    } catch {
      /* fall through */
    }
    return engine.defaultModel;
  }

  // longest <svg>...</svg>, else from first <svg, else raw
  static extractSvg(text) {
    if (!text) return '';
    let t = String(text);
    // strip thinking (some models emit reasoning first)
    t = t.replace(/ thinking[\s\S]*?<\/think>/gi, '');
    // strip triple-backtick code fences (any lang tag)
    t = t.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
    t = t.trim();
    const m = t.match(/<svg[\s\S]*?<\/svg>/i);
    if (m) return m[0];
    const start = t.toLowerCase().indexOf('<svg');
    if (start >= 0) return t.slice(start);
    return t;
  }

  static scoreParse(text) {
    if (!text) return null;
    const t = String(text);
    // clamp either way; labelled match may be negative
    const labelled = t.match(/score\s*[:=]?\s*(-?\d{1,3})(?:\s*[\/outof\s]+\s*(\d{1,3}))?/i);
    if (labelled) {
      return Math.max(0, Math.min(100, Number(labelled[1])));
    }
    const bare = t.match(/\b(\d{1,3})\b/);
    if (bare) {
      const n = Number(bare[1]);
      if (n >= 0 && n <= 100) return n;
    }
    return null;
  }

  static draftPrompt({ goal, w, h, prevSvg, feedback }) {
    const base = `You are a designer. Look at the attached image and create a clean SVG that visually matches it.
Goal: ${goal || 'reproduce the image as faithfully as possible'}
Target size: ${w} x ${h} (use these as your viewBox / width / height).
Constraints:
  - valid <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"> ... </svg>
  - use <rect>, <circle>, <path>, <text>, <g> as needed
  - pick colors that match the image; use hex codes
  - keep markup clean; no html comments
  - return ONLY the svg, no prose, no fences
  - DO NOT include thinking blocks`;
    if (prevSvg && feedback) {
      return `${base}

Previous SVG draft:
${prevSvg}

Critique of that draft:
${feedback}

Now produce a revised SVG that addresses the critique.`;
    }
    return base;
  }

  // one-shot text response (more reliable than json-mode across vision models); json is the documented fallback
  static critiquePrompt({ goal, w, h, draftSvg }) {
    return `You are a vision critic. Look at the attached reference image AND the rendered SVG of the draft.
Goal: ${goal || 'reproduce the image'}

Respond in this exact text format (no markdown, no code fences):

score: <0-100, how close the SVG is to the reference>
critique: <one short paragraph listing 2-4 specific things to fix>
fixes:
- <first specific fix>
- <second specific fix>
- <third specific fix (optional)>

If you must return JSON instead, use exactly:
{"score": <0-100>, "critique": "<paragraph>", "fixes": ["<fix1>", "<fix2>"]}

SVG (${w}x${h}):
${draftSvg}`;
  }

  static revisionPrompt({ draftSvg, critique, fixes, w, h }) {
    return `You are a designer. Revise the following SVG to address the critique.
Target: ${w}x${h}
Previous SVG:
${draftSvg}

Critique:
${critique}

Specific fixes to apply:
${fixes}

Return ONLY the revised <svg>...</svg> markup. No prose, no fences, no thinking blocks.`;
  }

  static parseCritique(text) {
    if (!text) return { score: null, critique: '', fixes: '' };
    const t = String(text).trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const o = JSON.parse(t);
        return {
          score: typeof o.score === 'number' ? o.score : null,
          critique: o.critique || '',
          fixes: Array.isArray(o.fixes) ? o.fixes.join('\n- ') : o.fixes || '',
        };
      } catch {
        /* fall through */
      }
    }
    const score = VisionLoop.scoreParse(t);
    const cMatch = t.match(/critique\s*:\s*([\s\S]*?)(?:\n\s*fixes\s*:|$)/i);
    const fMatch = t.match(/fixes\s*:\s*([\s\S]*?)$/i);
    return {
      score,
      critique: cMatch ? cMatch[1].trim() : t,
      fixes: fMatch ? fMatch[1].trim() : '',
    };
  }

  async run({
    source,
    goal = 'reproduce this image as a clean svg',
    iterations = 3,
    model,
    threshold = 90,
    width,
    height,
  } = {}) {
    const engine = this.engine;
    const img = await ImageUtils.resolve(source);
    const w = width || img.width || 800;
    const h = height || img.height || 600;

    let m = model;
    if (!m) m = await VisionLoop.pickVisionModel(engine);
    m = m || engine.defaultModel;

    this._emit('start', { model: m, w, h, iterations, threshold, source: img.source, bytes: img.bytes });
    const scores = [];
    let svg = '';
    let pngBase64 = '';
    let critique = '';
    let fixes = '';

    // 0 iters = no-op
    if (iterations <= 0) {
      this._emit('done', { iterations: 0 });
      return { ok: true, svg: '', pngBase64: '', model: m, iterations: 0, scores, width: w, height: h };
    }

    for (let i = 0; i < iterations; i++) {
      const draftPrompt = VisionLoop.draftPrompt({ goal, w, h, prevSvg: svg, feedback: critique });
      this._emit('drafting', { iter: i, model: m });
      const draft = await engine.chatVision({ model: m, base64: img.base64, prompt: draftPrompt });
      if (!draft.ok) {
        this._emit('error', { iter: i, stage: 'draft', error: draft.error });
        return { ok: false, error: draft.error, model: m, iterations: i, scores };
      }
      svg = VisionLoop.extractSvg(draft.content);
      this._emit('drafted', { iter: i, len: svg.length });

      const rendered = await tryRender(svg, w, h);
      if (rendered.error) {
        this._emit('render-failed', { iter: i, error: rendered.error, final: true });
        continue;
      }
      // render succeeded (possibly after auto-wrap); reflect any wrap back into `svg`
      svg = rendered.svg || svg;
      pngBase64 = rendered.base64;
      this._emit('rendered', { iter: i, bytes: rendered.bytes });

      const critPrompt = VisionLoop.critiquePrompt({ goal, w, h, draftSvg: svg });
      this._emit('critiquing', { iter: i, model: m });
      const crit = await engine.chatVision({
        model: m,
        base64: img.base64,
        // include rendered as 2nd image so critic sees both
        images: [img.base64, pngBase64],
        prompt: critPrompt,
      });
      if (!crit.ok) {
        this._emit('error', { iter: i, stage: 'critique', error: crit.error });
        return { ok: false, error: crit.error, model: m, svg, pngBase64, iterations: i + 1, scores };
      }
      const parsed = VisionLoop.parseCritique(crit.content);
      const score = parsed.score;
      critique = parsed.critique;
      fixes = parsed.fixes;
      scores.push({ iter: i, score, critique, fixes });
      this._emit('critiqued', { iter: i, score, hasCritique: !!critique, hasFixes: !!fixes });

      if (score != null && score >= threshold) {
        this._emit('converged', { iter: i, score });
        return {
          ok: true,
          svg,
          pngBase64,
          model: m,
          iterations: i + 1,
          finalScore: score,
          scores,
          source: img.source,
          width: w,
          height: h,
        };
      }

      // last iter? skip revision to save a call
      if (i === iterations - 1) break;

      const revPrompt = VisionLoop.revisionPrompt({ draftSvg: svg, critique, fixes, w, h });
      this._emit('revising', { iter: i, model: m });
      const rev = await engine.chatVision({
        model: m,
        base64: img.base64,
        images: [img.base64, pngBase64],
        prompt: revPrompt,
      });
      if (rev.ok) {
        svg = VisionLoop.extractSvg(rev.content);
        this._emit('revised', { iter: i, len: svg.length });
      } else {
        this._emit('revise-failed', { iter: i, error: rev.error });
      }
    }

    this._emit('done', { iterations: scores.length });
    return {
      ok: true,
      svg,
      pngBase64,
      model: m,
      iterations: scores.length,
      finalScore: scores.length ? scores[scores.length - 1].score : null,
      scores,
      source: img.source,
      width: w,
      height: h,
    };
  }
}

const deepthink_design_svg = async (args, ctx) => {
  const loop = new VisionLoop(ctx);
  return loop.run(args || {});
};

export default {
  deepthink_design_svg,
};
