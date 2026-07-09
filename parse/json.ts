// parse/json.ts
// single entry point for parsing LLM JSON output. regex extraction stays
// confined to this file; every consumer uses parseJsonSafe + a Zod schema,
// no inline JSON.parse.
import type { ZodType, ZodError } from 'zod';
import { stripCodeFences, stripThinkBlocks } from '../thinking/dataTypes.js';

export function extractJsonCandidate(text: string): string | null {
  if (!text) return null;
  const clean = stripThinkBlocks(text);

  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return clean.substring(start, i + 1);
    }
  }
  return null;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ZodError; raw: string };

export function parseJsonSafe<T>(text: string, schema: ZodType<T>): ParseResult<T> {
  const candidate = extractJsonCandidate(text ?? '');
  if (candidate == null) {
    return {
      ok: false,
      error: null as unknown as ZodError,
      raw: String(text ?? '')
    } as ParseResult<T>;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (e) {
    const cleaned = stripCodeFences(candidate);
    try {
      raw = JSON.parse(cleaned);
    } catch (e2) {
      return {
        ok: false,
        error: null as unknown as ZodError,
        raw: candidate
      } as ParseResult<T>;
    }
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error, raw: candidate };
}

export function tryParseJsonSafe<T>(text: string, schema: ZodType<T>): T | null {
  const r = parseJsonSafe(text, schema);
  return r.ok ? r.data : null;
}
