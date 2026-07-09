// thinking/smartCompression.ts
import { stripThinkBlocks, messagesToText } from './dataTypes.js';

export function approxTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function totalTokens(messages: { content: string }[]): number {
  let n = 0;
  for (const m of messages) n += approxTokens(m.content);
  return n;
}

function oldestSystem(messages: { role: string }[]): number {
  return messages.findIndex(m => m.role !== 'system');
}

type CallChat = (messages: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;

export async function compress(
  callChat: CallChat,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; think?: boolean; autoSystemPrompt?: boolean; samplingProfile?: string; [k: string]: unknown } = {}
): Promise<{ role: string; content: string }[]> {
  const max = opts.maxTokens || 6000;
  if (totalTokens(messages) <= max) return messages;
  const cutAt = Math.max(0, oldestSystem(messages) + 1);
  const head = messages.slice(0, cutAt);
  const middle = messages.slice(cutAt, -2);
  const tail = messages.slice(-2);
  if (!middle.length) return messages;
  const blob = middle.map((m, i) => `[${m.role.toUpperCase()} ${i + 1}]\n${m.content}`).join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'Compress the following conversation excerpt into the smallest set of facts that ' +
          'preserves decisions, constraints, numbers, and named entities. Drop filler and ' +
          'redundancy. Output plain text only — no labels, no markdown.'
      },
      { role: 'user', content: blob }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  const summary = stripThinkBlocks(r.content || '').trim();
  if (!summary) return messages;
  return [...head, { role: 'system', content: `[COMPRESSED CONTEXT]\n${summary}` }, ...tail];
}

export function truncateMiddle(
  messages: { role: string; content: string }[],
  keepFirst = 4,
  keepLast = 8
): { role: string; content: string }[] {
  if (messages.length <= keepFirst + keepLast) return messages;
  return [
    ...messages.slice(0, keepFirst),
    { role: 'system', content: `[... ${messages.length - keepFirst - keepLast} earlier messages truncated ...]` },
    ...messages.slice(-keepLast)
  ];
}
