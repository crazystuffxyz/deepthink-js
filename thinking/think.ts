// thinking/think.ts
import type { Message } from './types.js';

type CallChat = (messages: Message[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{ content: string }>;

async function singleThinkCall(
  callChat: CallChat,
  systemContent: string,
  userContent: string,
  context: string,
  opts: Record<string, unknown>
): Promise<string> {
  const messages: Message[] = [];
  if (context) {
    messages.push({
      role: 'system',
      content: 'Current thinking context (do NOT repeat this verbatim, build upon it):\n' + context
    });
  }
  messages.push({ role: 'system', content: systemContent });
  messages.push({ role: 'user', content: userContent });
  const r = await callChat(messages, false, null, { ...opts, think: true, autoSystemPrompt: false });
  return (r.content || '').trim();
}

export async function runThink(
  callChat: CallChat,
  inputText: string,
  depth: number,
  opts: Record<string, unknown>
): Promise<{ analysis?: string }> {
  const results: { analysis?: string } = {};
  if (depth <= 0) return results;

  let thinkingDoc = '';
  const call = async (systemContent: string): Promise<string> => {
    const chunk = await singleThinkCall(callChat, systemContent, inputText, thinkingDoc, opts);
    thinkingDoc += (thinkingDoc ? '\n\n' : '') + chunk;
    return chunk;
  };

  await call(
    'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
    'Perform rigorous mathematical and logical decomposition. Decompose the request into primitive logical units. ' +
    'Isolate all explicit and implicit variables, state boundary conditions, and define constraints using extreme-case analysis. ' +
    'Proactively identify potential off-by-one errors and domain-boundary violations.\n' +
    'Output format:\n' +
    'ANALYSIS: [your analysis — 3-6 bullet points max, no prose preamble]'
  );

  await call(
    'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
    'Based on the analysis above, identify the core intent, emotional subtext, ambiguities, and technical requirements.\n' +
    'Output format:\n' +
    'I need to:\n' +
    '1. [step]\n' +
    '2. [step]\n' +
    '3. [step]'
  );

  if (depth >= 2) {
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Generate an optimal computational strategy. Formulate a proof-sketch or step-by-step algorithm. ' +
      'Ensure that your plan defines a strict loop-invariant and verify that each step is constructively justified. ' +
      'Avoid non-constructive assertions.\n' +
      'Output format:\n' +
      '**Plan:**\n' +
      '[concise plan — max 5 steps]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Work through the problem systematically using numbered steps and sub-bullets.\n' +
      'Output format:\n' +
      'WORKING:\n' +
      '1. [step]\n' +
      '   - [sub-detail]\n' +
      '2. [step]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Define the structure of the final response in exactly 5 numbered steps.\n' +
      'Output format:\n' +
      '**Response Structure:**\n' +
      '1. [step]\n' +
      '2. [step]\n' +
      '3. [step]\n' +
      '4. [step]\n' +
      '5. [step]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Refine the working above. Improve clarity, correct logical gaps.\n' +
      'Output format:\n' +
      'REFINED:\n' +
      '[concise refined working — max 150 words]'
    );
  }

  if (depth >= 3) {
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Define the method for generating the final response.\n' +
      'Output format:\n' +
      'Method:\n' +
      '1. [step]\n' +
      '2. [step]\n' +
      '3. [step]\n' +
      '4. [step]\n' +
      '5. [step]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Propose an alternative method — different algorithmic approach, different framing, or different structure.\n' +
      'Output format:\n' +
      'ALTERNATIVE:\n' +
      '[max 100 words]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Perform a rigorous, adversarial proof audit of your intermediate reasoning. ' +
      'Proactively search for sign errors, division-by-zero vulnerabilities, boundary-condition leaks, and logical non-sequiturs. ' +
      'Do not restate your assumptions — actively attempt to falsify your own calculations.\n' +
      'Output format:\n' +
      'SANITY CHECK:\n' +
      '[findings — max 6 bullet points]'
    );
    await call(
      'You are performing INTERNAL REASONING ONLY. Do NOT answer the prompt. Do NOT produce any code or final deliverable. Be short and concise.\n' +
      'Produce a final 5-step plan that consolidates all reasoning above.\n' +
      'Output format:\n' +
      '1. [step]\n' +
      '2. [step]\n' +
      '3. [step]\n' +
      '4. [step]\n' +
      '5. [step]'
    );
  }

  results.analysis = thinkingDoc;
  return results;
}
