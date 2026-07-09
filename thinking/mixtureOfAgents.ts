// thinking/mixtureOfAgents.ts
import { messagesToText, stripThinkBlocks } from './dataTypes.js';

interface Caller {
  name: string;
  callChat: (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;
}

type CallChat = Caller['callChat'];

interface RunOpts {
  autoSystemPrompt?: boolean;
  think?: boolean;
  samplingProfile?: string;
  [k: string]: unknown;
}

async function fanOut(callers: Caller[], input: unknown, opts: RunOpts = {}): Promise<{ name: string; content?: string; error?: string }[]> {
  const msgs = Array.isArray(input) ? input : [{ role: 'user', content: messagesToText(input) }];
  const tasks = callers.map(c =>
    c.callChat(
      msgs,
      false,
      null,
      {
        ...opts,
        autoSystemPrompt: opts.autoSystemPrompt ?? false,
        think: opts.think !== false,
        samplingProfile: opts.samplingProfile || 'reasoning'
      }
    )
      .then(r => ({ name: c.name, content: stripThinkBlocks(r.content || '').trim() }))
      .catch(e => ({ name: c.name, error: (e as Error).message }))
  );
  return Promise.all(tasks);
}

async function judge(
  callChat: CallChat,
  input: unknown,
  candidates: { name: string; content?: string }[],
  opts: RunOpts = {}
): Promise<string> {
  const list = candidates.map((c, i) => `--- Candidate ${i + 1} [${c.name}] ---\n${c.content}`).join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are the merge judge. You receive multiple candidate answers to the same question. ' +
          'Produce a single, better answer that combines the strongest elements of each. ' +
          'Resolve contradictions by preferring the more specific / better-grounded claim. ' +
          'Output ONLY the merged final answer — no JSON, no preamble.'
      },
      { role: 'user', content: `Question:\n${messagesToText(input)}\n\nCandidates:\n${list}\n\nMerged answer:` }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

export async function runMoA(
  callers: Caller[],
  judgeCaller: CallChat,
  input: unknown,
  opts: RunOpts = {}
): Promise<{ answer: string; candidates: { name: string; content?: string; error?: string }[] }> {
  const out = await fanOut(callers, input, opts);
  const ok = out.filter(x => !x.error && x.content);
  if (!ok.length) throw new Error('mixtureOfAgents: all candidates failed');
  if (ok.length === 1) return { answer: ok[0]!.content!, candidates: out };
  const merged = await judge(judgeCaller, input, ok as { name: string; content?: string }[], opts);
  return { answer: merged, candidates: out };
}

export { fanOut, judge };
