// thinking/planAndExecute.ts
import { stripThinkBlocks, messagesToText } from './dataTypes.js';
import { parseJsonSafe, tryParseJsonSafe } from '../parse/json.js';
import { PlanSchema } from '../parse/llmSchemas.js';

type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;

export async function makePlan(
  callChat: CallChat,
  input: unknown,
  opts: Record<string, unknown> = {}
): Promise<string[]> {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a strategic planner. Decompose the user request into a small, ordered list of atomic steps.\n' +
          'Each step is something one LLM call can answer independently.\n' +
          'Output ONLY valid JSON: {"plan":["step 1","step 2",...],"reasoning":"one short sentence"}'
      },
      { role: 'user', content: messagesToText(input) }
    ],
    false,
    null,
    { ...opts, think: true, autoSystemPrompt: false, samplingProfile: 'planning' }
  );
  const parsed = tryParseJsonSafe(r.content || '', PlanSchema);
  if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) {
    return parsed.steps.map(s => s.action);
  }
  return [`Address: ${messagesToText(input).slice(0, 400)}`];
}

export async function runStep(
  callChat: CallChat,
  step: string,
  prior: string,
  inputText: string,
  opts: Record<string, unknown>
): Promise<string> {
  const sys =
    'You are an executor. Solve the current step using everything already known from prior steps. ' +
    'Be concrete, no preamble, no meta commentary. Just the result.';
  const user = prior
    ? `Original: ${inputText}\n\nPrior steps:\n${prior}\n\nCurrent step: ${step}\n\nResult:`
    : `Original: ${inputText}\n\nStep: ${step}\n\nResult:`;
  const r = await callChat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

export async function reflect(
  callChat: CallChat,
  step: string,
  output: string,
  inputText: string,
  opts: Record<string, unknown>
): Promise<string> {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a self-critic. Audit the step output. If you find errors, return a fixed version. ' +
          'If the output is good, return it unchanged. Output ONLY the corrected (or original) text.'
      },
      {
        role: 'user',
        content: `Original: ${inputText}\n\nStep: ${step}\n\nOutput: ${output}\n\nFinal version:`
      }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'verify' }
  );
  return stripThinkBlocks(r.content || '').trim();
}

export async function runPlanAndExecute(
  callChat: CallChat,
  input: unknown,
  opts: { reflect?: boolean; [k: string]: unknown } = {}
): Promise<{ plan: string[]; steps: { step: string; output: string }[]; answer: string }> {
  const inputText = messagesToText(input);
  const plan = await makePlan(callChat, input, opts);
  const results: { step: string; output: string }[] = [];
  let prior = '';
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    let out = await runStep(callChat, step, prior, inputText, opts);
    if (opts.reflect !== false) out = await reflect(callChat, step, out, inputText, opts);
    results.push({ step, output: out });
    prior += `\n[Step ${i + 1}] ${step}\n${out}\n`;
  }
  const synth = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a final-synthesis agent. Combine the step results into one coherent final answer. ' +
          'Be concise, do not repeat the steps verbatim. Just the answer.'
      },
      { role: 'user', content: `Original: ${inputText}\n\nSteps:\n${prior}\n\nFinal answer:` }
    ],
    false,
    null,
    { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'creative' }
  );
  return { plan, steps: results, answer: stripThinkBlocks(synth.content || '').trim() };
}
