// thinking/toolUse.js — model emits JSON tool calls, we run them in a sandbox, loop
'use strict';

import { stripCodeFences, stripThinkBlocks, messagesToText } from './dataTypes.js';
import { runJSSandbox, runPythonSandbox } from './codeGenerator.js';

const DEFAULT_TOOLS = [
  {
    name: 'js_eval',
    description: 'Run JavaScript in a sandbox and return the printed output.',
    params: { code: 'string — complete Node.js script' }
  },
  {
    name: 'py_eval',
    description: 'Run Python in a sandbox and return the printed output.',
    params: { code: 'string — complete Python 3 script' }
  },
  {
    name: 'finish',
    description: 'Call this when the answer is ready. params.answer holds the final text.',
    params: { answer: 'string — the final user-facing answer' }
  }
];

function describeTools(tools) {
  return tools.map(t => `- ${t.name}: ${t.description}\n  params: ${JSON.stringify(t.params)}`).join('\n');
}

function parseToolCall(text) {
  // try plain JSON
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j === 'object' && j.tool) return j;
    } catch {}
  }
  // try ```json fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  return null;
}

async function executeTool(call, tools) {
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

async function toolLoop(callChat, input, opts = {}) {
  const tools = opts.tools || DEFAULT_TOOLS;
  const max = Math.max(1, Math.min(opts.maxSteps || 5, 12));
  const sys =
    'You have access to tools. When you want to use one, output ONLY valid JSON of the form ' +
    '{"tool":"<name>","params":{...}}. To finish, output {"tool":"finish","params":{"answer":"..."}}.\n\n' +
    'Tools available:\n' + describeTools(tools);
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: messagesToText(input) }
  ];
  const trace = [];
  for (let i = 0; i < max; i++) {
    const r = await callChat(msgs, false, null, { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' });
    const text = stripThinkBlocks(r.content || '');
    const call = parseToolCall(text);
    if (!call) {
      // no tool call -> just return the text
      return { answer: text.trim(), steps: trace, finished: true };
    }
    trace.push({ step: i + 1, call });
    if (call.tool === 'finish') {
      return { answer: String(call.params?.answer || '').trim(), steps: trace, finished: true };
    }
    let output = '';
    try {
      const exec = await executeTool(call, tools);
      output = await exec.run();
    } catch (e) {
      output = `ERROR: ${e.message}`;
    }
    trace[trace.length - 1].output = output;
    msgs.push({ role: 'assistant', content: text.trim() });
    msgs.push({ role: 'user', content: `Tool ${call.tool} returned:\n${String(output).slice(0, 2000)}\n\nDecide next step.` });
  }
  return { answer: trace.at(-1)?.output || '', steps: trace, finished: false };
}

export { toolLoop, parseToolCall, describeTools, DEFAULT_TOOLS };
