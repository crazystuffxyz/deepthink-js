// thinking/dataTypes.ts
export function stripThinkBlocks(t: string | null | undefined): string {
  return String(t ?? '').replace(/<\s*think[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, '').trim();
}

export function stripCodeFences(t: string | null | undefined): string {
  return String(t ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

export type DataType = 'integer' | 'double' | 'boolean' | 'string' | string;

export function parseDataType(text: string, dataType: DataType): number | boolean | string {
  const t = stripThinkBlocks(text);
  switch (String(dataType).toLowerCase()) {
    case 'integer': {
      const matches = t.match(/-?\d+/g);
      return matches ? parseInt(matches[matches.length - 1] ?? '0', 10) : 0;
    }
    case 'double': {
      const matches = t.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g);
      return matches ? parseFloat(matches[matches.length - 1] ?? '0') : 0.0;
    }
    case 'boolean': {
      const l = t.toLowerCase().trim();
      const trueSignals = ['true', 'yes', '1', 'correct', 'valid'];
      const falseSignals = ['false', 'no', '0', 'incorrect', 'invalid'];
      if (trueSignals.some(s => l.endsWith(s))) return true;
      if (falseSignals.some(s => l.endsWith(s))) return false;
      return l.includes('true') && !l.match(/\b(not|never|isn't|false)\b/);
    }
    default:
      return t;
  }
}

export function extractJSON(text: string): unknown {
  const clean = stripThinkBlocks(text);
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.substring(firstBrace, lastBrace + 1));
    } catch (e) {
      throw new Error(`JSON boundary extraction failed: ${(e as Error).message}`);
    }
  }
  return JSON.parse(stripCodeFences(clean));
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  images?: string[];
  tool_calls?: unknown[];
}

export const isChatMessage = (m: unknown): m is ChatMessage =>
  isPlainObject(m) && typeof m.role === 'string' && typeof m.content === 'string';

export function cloneMessage(m: ChatMessage): ChatMessage {
  const o: ChatMessage = {
    role: m.role,
    content: String(m.content ?? '')
  };
  if (Array.isArray(m.images)) o.images = [...m.images];
  if (typeof m.name === 'string') o.name = m.name;
  if (Array.isArray(m.tool_calls)) {
    o.tool_calls = m.tool_calls.map(tc => ({ ...(tc as Record<string, unknown>) }));
  }
  return o;
}

export function messagesToText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((m, i) =>
        isChatMessage(m) ? `[${m.role.toUpperCase()} ${i + 1}]\n${m.content}` : `[ITEM ${i + 1}]\n${JSON.stringify(m, null, 2)}`
      )
      .join('\n\n');
  }
  if (isPlainObject(input)) return JSON.stringify(input, null, 2);
  return String(input);
}

export function normalizeInputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    if (input.every(isChatMessage)) return input.map(cloneMessage);
    return [{ role: 'user', content: JSON.stringify(input, null, 2) }];
  }
  if (isPlainObject(input)) {
    const msgs = (input as { messages?: unknown }).messages;
    if (Array.isArray(msgs) && msgs.every(isChatMessage)) return msgs.map(cloneMessage);
    if (typeof (input as { role?: unknown }).role === 'string') {
      return [cloneMessage(input as unknown as ChatMessage)];
    }
    return [{ role: 'user', content: JSON.stringify(input, null, 2) }];
  }
  return [{ role: 'user', content: String(input) }];
}

export function createDefaultSystemPrompt(type: string, depth: number): string {
  const parts: string[] = ['You are Deepthink, a precise and helpful assistant.'];
  parts.push(type === 'string' ? 'Respond clearly and helpfully.' : `Return only a valid ${type} and nothing else.`);
  if (depth > 0) parts.push('Use careful internal reasoning but keep it out of your final answer.');
  return parts.join(' ');
}
