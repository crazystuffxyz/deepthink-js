// thinking/toolUse.ts
import { stripThinkBlocks, messagesToText } from './dataTypes.js';
import { runJSSandbox, runPythonSandbox } from '../codeGenerator/index.js';

type Tool = { name: string; description: string; params: Record<string, string>; run?: (params: Record<string, unknown>) => Promise<unknown> };
type ToolCall = { tool: string; params?: Record<string, unknown>; code?: string };
type ChatResult = { content: string; thinking?: string };
type CallChat = (msgs: ChatMessage[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<ChatResult>;
type ChatMessage = { role: string; content: string };

const DEFAULT_TOOLS: Tool[] = [
  { name: 'js_eval', description: 'Run JavaScript in a sandbox and return the printed output.', params: { code: 'string — complete Node.js script' } },
  { name: 'py_eval', description: 'Run Python in a sandbox and return the printed output.', params: { code: 'string — complete Python 3 script' } },
  { name: 'finish', description: 'Call this when the answer is ready. params.answer holds the final text.', params: { answer: 'string — the final user-facing answer' } }
];

function describeTools(tools: Tool[]): string {
  return tools.map(t => `- ${t.name}: ${t.description}\n  params: ${JSON.stringify(t.params)}`).join('\n');
}

function parseToolCall(text: string): ToolCall | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j === 'object' && j.tool) return j as ToolCall;
    } catch { /* try fence */ }
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]) as ToolCall; } catch { return null; }
  }
  return null;
}

async function executeTool(call: ToolCall, tools: Tool[]): Promise<{ name: string; run: () => Promise<unknown> }> {
  const map = new Map(tools.map(t => [t.name, t]));
  return {
    name: call.tool,
    async run() {
      const t = map.get(call.tool);
      if (!t) throw new Error(`Unknown tool: ${call.tool}`);
      if (call.tool === 'js_eval') return await runJSSandbox(String(call.code || ''));
      if (call.tool === 'py_eval') return await runPythonSandbox(String(call.code || ''));
      if (typeof t.run === 'function') return await t.run(call.params || {});
      return null;
    }
  };
}

type TraceStep = { step: number; call: ToolCall; output?: unknown };

async function toolLoop(callChat: CallChat, input: unknown, opts: { tools?: Tool[] | boolean; maxSteps?: number; [k: string]: unknown } = {}): Promise<{ answer: string; steps: TraceStep[]; finished: boolean }> {
  const tools = (Array.isArray(opts.tools) ? opts.tools as Tool[] : DEFAULT_TOOLS);
  const max = Math.max(1, Math.min(opts.maxSteps || 5, 12));
  const sys = 'You have access to tools. When you want to use one, output ONLY valid JSON of the form ' +
    '{"tool":"<name>","params":{...}}. To finish, output {"tool":"finish","params":{"answer":"..."}}.\n\n' +
    'Tools available:\n' + describeTools(tools);
  const msgs: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: messagesToText(input) }
  ];
  const trace: TraceStep[] = [];
  for (let i = 0; i < max; i++) {
    const r = await callChat(msgs, false, null, { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' } as unknown as Record<string, unknown>);
    const text = stripThinkBlocks(r.content || '');
    const call = parseToolCall(text);
    if (!call) return { answer: text.trim(), steps: trace, finished: true };
    trace.push({ step: i + 1, call });
    if (call.tool === 'finish') return { answer: String(call.params?.answer || '').trim(), steps: trace, finished: true };
    let output: unknown = '';
    try {
      const exec = await executeTool(call, tools);
      output = await exec.run();
    } catch (e) {
      output = `ERROR: ${(e as Error).message}`;
    }
    trace[trace.length - 1].output = output;
    msgs.push({ role: 'assistant', content: text.trim() });
    msgs.push({ role: 'user', content: `Tool ${call.tool} returned:\n${String(output).slice(0, 2000)}\n\nDecide next step.` });
  }
  return { answer: String(trace.at(-1)?.output || ''), steps: trace, finished: false };
}

export { toolLoop, parseToolCall, describeTools, DEFAULT_TOOLS };
export type { Tool, ToolCall, TraceStep };
