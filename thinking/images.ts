// thinking/images.ts
// multimodal plumbing: turn file paths / URLs / raw base64 into data URIs the
// providers understand, and describe images with a vision model so text-only
// models can still work with them.

import fs from 'node:fs';
import path from 'node:path';
import axios from '../internet/axios.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

function mimeFor(name: string, fallback = 'image/jpeg'): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || fallback;
}

// normalize any image source to a base64 data URI
export async function loadImages(sources: Array<string | { path?: string; url?: string; data?: string; base64?: string }>): Promise<string[]> {
  const out: string[] = [];
  for (const src of sources) {
    if (typeof src === 'string') {
      if (src.startsWith('data:')) { out.push(src); continue; }
      if (/^https?:\/\//i.test(src)) {
        const r = await axios.get(src, { responseType: 'arraybuffer', timeout: 20000 });
        const buf = Buffer.from(r.data as ArrayBuffer);
        const ct = String(r.headers['content-type'] || '').split(';')[0].trim() || mimeFor(src);
        out.push(`data:${ct};base64,${buf.toString('base64')}`);
        continue;
      }
      if (fs.existsSync(src)) {
        const buf = fs.readFileSync(src);
        out.push(`data:${mimeFor(src)};base64,${buf.toString('base64')}`);
        continue;
      }
      // bare base64 — only if it actually looks like base64 (a typo'd file
      // path like "C:/img.png" must not become a garbage data URI)
      if (/^[A-Za-z0-9+/=]+$/.test(src)) {
        out.push(`data:image/jpeg;base64,${src.replace(/^data:[^;]+;base64,/, '')}`);
      }
      continue;
    }
    if (src?.data) { out.push(src.data); continue; }
    if (src?.base64) { out.push(`data:image/jpeg;base64,${src.base64}`); continue; }
    if (src?.path && fs.existsSync(src.path)) {
      const buf = fs.readFileSync(src.path);
      out.push(`data:${mimeFor(src.path)};base64,${buf.toString('base64')}`);
      continue;
    }
    if (src?.url) {
      const r = await axios.get(src.url, { responseType: 'arraybuffer', timeout: 20000 });
      const buf = Buffer.from(r.data as ArrayBuffer);
      const ct = String(r.headers['content-type'] || '').split(';')[0].trim() || mimeFor(src.url);
      out.push(`data:${ct};base64,${buf.toString('base64')}`);
      continue;
    }
  }
  return out;
}

// describe images with a vision model so a text-only model can reason about
// them. returns a single text block with one description per image.
export async function describeImages(callChat: any, images: string[], opts: any = {}): Promise<string> {
  const visionModel = opts.visionModel || process.env.DEEPTHINK_VISION_MODEL;
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const r = await callChat(
      [{ role: 'system', content: 'You are a precise image describer. Describe this image in exhaustive detail: every object, number, text, diagram, chart axis, label, and relationship. If it is a chart or graph, transcribe the exact values. If it is a math problem, transcribe the problem exactly. Do not interpret — transcribe.' },
       { role: 'user', content: `Image ${i + 1} of ${images.length}.`, images: [images[i]] }],
      false, null, { ...opts, think: false, autoSystemPrompt: false, model: visionModel || undefined });
    parts.push(`[Image ${i + 1}]\n${(r.content || '').trim()}`);
  }
  return parts.join('\n\n');
}

// does the model name look vision-capable? used only as a hint — the real
// test is whether the provider accepts the image. gemma4 is deliberately NOT
// listed: when a visionModel is configured, describing is always safe, while
// passing an image to a text-only model fails — so unknown models default to
// "describe".
export function looksVisionCapable(model: string): boolean {
  const m = String(model || '').toLowerCase();
  return /vision|vl|multimodal|gemma3|llava|qwen2?-?vl|qwen3\.5|minimax-m3|gpt-4o|gpt-5|claude|gemini|pixtral/i.test(m);
}
