// thinking/consistency.ts
import { messagesToText, stripThinkBlocks } from './dataTypes.js';

type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;

async function sampleOnce(
  callChat: CallChat,
  input: unknown,
  opts: { samplingProfile?: string; think?: boolean; autoSystemPrompt?: boolean; [k: string]: unknown }
): Promise<string> {
  const msgs = Array.isArray(input) ? input : [{ role: 'user', content: messagesToText(input) }];
  const r = await callChat(msgs, false, null, {
    ...opts,
    samplingProfile: opts.samplingProfile || 'reasoning',
    think: opts.think !== false,
    autoSystemPrompt: opts.autoSystemPrompt ?? false
  });
  return (r.content || '').trim();
}

export function vote(samples: string[]): string {
  if (!samples.length) return '';
  const counts = new Map<string, number>();
  for (const s of samples) {
    const k = s.replace(/\s+/g, ' ').trim();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && k.length > best.length)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export async function selfConsistency(
  callChat: CallChat,
  input: unknown,
  opts: { samples?: number; samplingProfile?: string; [k: string]: unknown } = {}
): Promise<{ answer: string; samples: string[]; count: number; votes: number }> {
  const n = Math.max(1, Math.min(opts.samples || 5, 11));
  const profile = opts.samplingProfile || 'reasoning';
  const tasks: Promise<string>[] = [];
  for (let i = 0; i < n; i++) {
    tasks.push(sampleOnce(callChat, input, { ...opts, samplingProfile: profile }));
  }
  const out = await Promise.allSettled(tasks);
  const ok = out.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value);
  if (!ok.length) throw new Error('selfConsistency: all samples failed');
  const winner = vote(ok);
  return { answer: winner, samples: ok, count: ok.length, votes: winner === vote(ok) ? 1 : 0 };
}

export { sampleOnce };
