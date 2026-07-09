// thinking/analytical.ts
import { messagesToText, parseDataType, stripCodeFences, stripThinkBlocks } from './dataTypes.js';
import { tryParseJsonSafe } from '../parse/json.js';
import { z } from 'zod';

type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;
type Generate = (input: unknown, opts: Record<string, unknown>) => Promise<unknown>;
type Limiter = { run<T>(fn: () => Promise<T>): Promise<T> };
type Context = { callChat: CallChat; generate: Generate; limiter: Limiter };
type OnChunk = ((chunk: string) => void) | null;

const DecompSchema = z.union([
  z.object({
    decomposable: z.literal(true),
    subProblems: z.array(z.string()).min(2),
    mergeOperation: z.enum(['add', 'multiply', 'custom']).optional(),
    sharedConstraints: z.array(z.string()).optional()
  }),
  z.object({
    decomposable: z.literal(false),
    subProblems: z.array(z.string()).default([])
  })
]);

async function analyzeDecomposability(
  callChat: CallChat,
  inputText: string,
  analyticalDepth: number,
  opts: Record<string, unknown>
): Promise<z.infer<typeof DecompSchema>> {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a problem decomposition engine (depth ${analyticalDepth}).\n` +
          'Determine if this problem has 2-4 INDEPENDENT sub-problems — parts that do NOT depend on each other.\n' +
          'Be MORE conservative at depth >= 2. Atomic/single questions are never decomposable.\n\n' +
          'Output ONLY valid JSON:\n' +
          '{"decomposable":true,"subProblems":["..."],"mergeOperation":"add"|"multiply"|"custom","sharedConstraints":["..."]}\n' +
          'OR {"decomposable":false,"subProblems":[]}'
      },
      { role: 'user', content: inputText }
    ],
    false,
    null,
    { ...opts, think: false }
  );
  const parsed = tryParseJsonSafe(r.content || '', DecompSchema);
  if (parsed) return parsed;
  return { decomposable: false, subProblems: [] };
}

async function mergeSubResults(
  callChat: CallChat,
  originalInput: unknown,
  subProblems: string[],
  subResults: string[],
  decomp: { mergeOperation?: 'add' | 'multiply' | 'custom'; sharedConstraints?: string[] },
  opts: Record<string, unknown>,
  log?: (level: 'info' | 'warn', msg: string) => void
): Promise<string> {
  const op = decomp?.mergeOperation;
  if (op === 'add' || op === 'multiply') {
    const nums = subResults.map(r => parseDataType(String(r), 'double') as number);
    if (nums.every(n => !isNaN(n) && isFinite(n))) {
      const result = op === 'add' ? nums.reduce((a, b) => a + b, 0) : nums.reduce((a, b) => a * b, 1);
      log?.('info', `[MERGE] Programmatic ${op}: ${nums.join(op === 'add' ? '+' : '×')} = ${result}`);
      return String(result);
    }
    log?.('warn', '[MERGE] Non-numeric elements or parsing failure — falling back to LLM synthesis');
  }
  const mergeText = subProblems.map((sp, i) => `Sub-problem ${i + 1}: ${sp}\nResult: ${subResults[i]}`).join('\n\n');
  const constraintNote = decomp?.sharedConstraints?.length
    ? `\n\nShared Constraints:\n${decomp.sharedConstraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`
    : '';
  const r = await callChat(
    [
      {
        role: 'system',
        content: 'Synthesize multiple sub-problem results into ONE complete final answer. Output ONLY the synthesized answer.'
      },
      {
        role: 'user',
        content: `Original: ${messagesToText(originalInput)}\n\n${mergeText}${constraintNote}\n\nSynthesized answer:`
      }
    ],
    false,
    null,
    { ...opts, think: false }
  );
  return (r.content || '').trim();
}

export async function analyzeAndSolve(
  ctx: Context,
  input: unknown,
  type: string,
  depth: number,
  checks: unknown,
  onChunk: OnChunk,
  opts: Record<string, unknown>,
  analyticalDepth = 0
): Promise<unknown> {
  const { callChat, generate, limiter } = ctx;
  const max = (opts.analyticalMaxDepth as number) ?? 4;
  const inputText = messagesToText(input);
  if (analyticalDepth >= max) {
    return generate(input, { ...opts, type, depth, checks, onChunk, analytical: false });
  }
  const decomp = await analyzeDecomposability(callChat, inputText, analyticalDepth, opts);
  if (!decomp.decomposable || !Array.isArray(decomp.subProblems) || decomp.subProblems.length < 2) {
    return generate(input, {
      ...opts,
      type,
      depth,
      checks,
      onChunk: analyticalDepth === 0 ? onChunk : null,
      analytical: false
    });
  }
  const subResults = await Promise.all(
    decomp.subProblems.map(sp =>
      limiter.run(() => analyzeAndSolve(ctx, sp, type, depth, 0, null, { ...opts, analytical: true }, analyticalDepth + 1))
    )
  );
  const merged = await mergeSubResults(callChat, input, decomp.subProblems, subResults as string[], decomp, opts);
  return parseDataType(merged, type !== 'string' ? type : 'string');
}

export { analyzeDecomposability, mergeSubResults };
