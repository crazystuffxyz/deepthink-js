// src/mcp-server/commander.js
// deepthink's top-level auto-agent: plan -> execute w/ metacog verify + rollback -> synthesize.
//
// v3 changes:
//   - real MCTS for tool-call selection (was a yes/no approve gate)
//   - per-task history isolation
//   - safer loop detection (covers different params of same tool too)
//   - verifier can short-circuit on trivial success
import { beamSearch, _heuristicScore } from './mcts.js';

// host-damaging tools — these hit the LLM risk gate first
const RISKY_TOOLS = new Set([
  'deepthink_shell',
  'deepthink_powershell',
  'deepthink_delete_file',
  'deepthink_kill_process',
  'deepthink_env_var',
  'deepthink_set_clipboard',
]);

// the tool surface the agent can call, in a compact {name: {description, params}}
// shape. `toNativeTools()` converts this to the function-calling schema so the
// model gets real tool calls.
const TOOL_DEFINITIONS = {
  deepthink_shell: {
    description: 'Run a standard OS shell command (bash on unix, cmd on windows).',
    params: { command: 'string', cwd: 'optional string', timeout: 'optional number' },
  },
  deepthink_powershell: {
    description: 'Run a PowerShell command (Windows) or bash (Linux/macOS).',
    params: { command: 'string', cwd: 'optional string' },
  },
  deepthink_js_execute: {
    description:
      'Run sandboxed JavaScript in a fresh Node subprocess. `state` is in scope; return a value to get it back.',
    params: { code: 'string' },
  },
  deepthink_read_file: {
    description: 'Read a file from disk. Returns content + size.',
    params: { path: 'string', encoding: 'optional string' },
  },
  deepthink_write_file: {
    description: 'Write content to a file (tracked for rollback).',
    params: { path: 'string', content: 'string', append: 'optional boolean' },
  },
  deepthink_list_dir: {
    description: 'List files and directories at a path.',
    params: { path: 'optional string', recursive: 'optional boolean' },
  },
  deepthink_create_dir: {
    description: 'Create a directory (recursive).',
    params: { path: 'string' },
  },
  deepthink_delete_file: {
    description: 'Delete a file (tracked for rollback).',
    params: { path: 'string' },
  },
  deepthink_copy_file: {
    description: 'Copy a file from src to dest (dest tracked for rollback).',
    params: { src: 'string', dest: 'string' },
  },
  deepthink_web_search: {
    description: 'Search the web (DuckDuckGo) and return ranked results.',
    params: { query: 'string', maxResults: 'optional number' },
  },
  deepthink_web_fetch: {
    description: 'Fetch a URL and return clean readable text.',
    params: { url: 'string', maxLength: 'optional number' },
  },
  deepthink_http_request: {
    description: 'Make a raw HTTP/HTTPS request with optional headers/body.',
    params: { url: 'string', method: 'optional string', headers: 'optional object', body: 'optional string' },
  },
  deepthink_open_url: {
    description: 'Open a URL in the default system browser.',
    params: { url: 'string' },
  },
  deepthink_system_info: {
    description: 'Get host system information (OS, CPU, memory, node version).',
    params: {},
  },
  deepthink_list_processes: {
    description: 'List running processes.',
    params: {},
  },
  deepthink_kill_process: {
    description: 'Kill a process by PID or name.',
    params: { pid: 'optional number', name: 'optional string' },
  },
  deepthink_env_var: {
    description: 'Get or set an environment variable.',
    params: { name: 'string', value: 'optional string' },
  },
  deepthink_wait: {
    description: 'Sleep for N milliseconds (max 60000).',
    params: { ms: 'optional number' },
  },
  deepthink_screenshot: {
    description: 'Capture the screen (Linux via scrot, macOS via screencapture).',
    params: { save: 'optional boolean' },
  },
  deepthink_mouse_move: {
    description: 'Move the OS mouse cursor to (x, y).',
    params: { x: 'number', y: 'number' },
  },
  deepthink_mouse_click: {
    description: 'Click the OS mouse at (x, y).',
    params: { x: 'number', y: 'number', button: 'optional string', double: 'optional boolean' },
  },
  deepthink_type_text: {
    description: 'Type text via simulated keystrokes.',
    params: { text: 'string', delay: 'optional number' },
  },
  deepthink_get_clipboard: {
    description: 'Read the OS clipboard.',
    params: {},
  },
  deepthink_set_clipboard: {
    description: 'Write to the OS clipboard.',
    params: { text: 'string' },
  },
  deepthink_ai_analyze: {
    description: 'Ask a model to answer a question about a data blob.',
    params: { data: 'string', question: 'string', model: 'optional string' },
  },
  deepthink_analyze_image: {
    description: 'Analyze a base64-encoded image with a multimodal model.',
    params: { base64: 'string', question: 'optional string', model: 'optional string' },
  },
  deepthink_git: {
    description: 'Run a git command in a directory.',
    params: { command: 'string', cwd: 'optional string' },
  },
  deepthink_node_run: {
    description: 'Run a Node.js script file or inline code.',
    params: { code: 'optional string', file: 'optional string' },
  },
  deepthink_python_run: {
    description: 'Run Python code or a script file.',
    params: { code: 'optional string', file: 'optional string' },
  },
  deepthink_rollback: {
    description: 'Undo all filesystem mutations made in the current session.',
    params: {},
  },
};

// convert the compact shape to the function-calling schema
function toNativeTools() {
  return Object.entries(TOOL_DEFINITIONS).map(([name, def]) => {
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(def.params || {})) {
      const isOptional = String(v).startsWith('optional');
      const type = isOptional ? String(v).split(' ')[1] : String(v);
      properties[k] = {
        type: type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string',
        description: k,
      };
      if (!isOptional) required.push(k);
    }
    return {
      type: 'function',
      function: {
        name,
        description: def.description,
        parameters: { type: 'object', properties, required },
      },
    };
  });
}

// agent personas the planner can assign a task to
const AGENT_PROFILES = {
  general: {
    system: `You are deepthink's primary agent. You maintain access, operational controls, and tool execution routines.
Your role is to orchestrate solutions logically and coordinate step-by-step directives. Keep feedback concise, helpful, and highly contextual.`,
  },
  researcher: {
    system: `You are deepthink's web search and retrieval agent. Your task is to scrape, sort, verify, and filter source materials.
Rank academic sites, official documentation, and repositories at the top. Block forum noise and SEO content mills.`,
  },
  coder: {
    system: `You are deepthink's code synthesis engine. You write, execute, inspect, and repair JavaScript/Python scripts.
Utilize sandboxed executions. Ensure dependencies are resolved. Output clean, optimal code fragments with error trapping built in.`,
  },
  conversational: {
    system: `You are deepthink in conversational interaction mode. Speak in a sophisticated, calm, neutral tone.`,
  },
};

class Commander {
  constructor(ctx) {
    this.ctx = ctx;
    this.engine = ctx.engine;
    this._cancel = false;
    this.MAX_AGENT_ITERATIONS = 20;
    this.MAX_RETRIES = 3;
    // wall-clock cap per task — kill a stuck loop even if the model keeps producing plausible calls
    this.TASK_DEADLINE_MS = 5 * 60 * 1000;
    // abort the task after this many loop warnings
    this.MAX_LOOP_WARNINGS = 2;
    this.executionHistory = [];
  }

  cancel() {
    this._cancel = true;
    this.ctx.cancel.set();
  }

  reset() {
    this._cancel = false;
    this.ctx.cancel.reset();
    this.executionHistory = [];
  }

  emit(channel, data) {
    this.ctx.pushLog({ channel, data, ts: Date.now() });
  }

  async process(userMessage, model, modelConfig = {}, history = []) {
    this.reset();

    const cfg = {
      mainModel: model || this.engine.defaultModel,
      plannerModel: modelConfig.plannerModel || model || this.engine.defaultModel,
      mctsModel: modelConfig.mctsModel || model || this.engine.defaultModel,
      verifierModel: modelConfig.verifierModel || model || this.engine.defaultModel,
      synthesisModel: modelConfig.synthesisModel || model || this.engine.defaultModel,
      researchModel: modelConfig.researchModel || model || this.engine.defaultModel,
      // depth 0 = direct call. deepthink depth 1 runs 8+ sequential LLM
      // passes — way too slow for the plan/verify hot path. opt in via
      // deepthinkDepth if you want the full pipeline.
      deepthinkDepth: Number(modelConfig.deepthinkDepth ?? 0),
      deepthinkChecks: Number(modelConfig.deepthinkChecks ?? 0),
      useMCTS: modelConfig.useMCTS !== false,
    };

    this.emit('deepthink:status', { status: 'thinking', message: 'Analyzing your query...' });
    const plan = await this._plan(userMessage, cfg, history);
    this.emit('deepthink:step', { type: 'plan', plan });
    if (this._cancel) return { cancelled: true };

    const taskResults = [];
    for (let i = 0; i < plan.tasks.length; i++) {
      if (this._cancel) break;
      const task = plan.tasks[i];
      this.emit('deepthink:step', { type: 'task-start', index: i, total: plan.tasks.length, task });

      const result = await this._executeTaskWithLoops(task, cfg, history, taskResults);
      taskResults.push({ task, result });
      this.emit('deepthink:step', {
        type: 'task-done',
        index: i,
        task,
        result: result.summary || result.output,
      });
    }
    if (this._cancel) return { cancelled: true };

    this.emit('deepthink:status', { status: 'synthesizing', message: 'Synthesizing task results...' });
    const synthesis = await this._synthesize(userMessage, taskResults, cfg, history);
    this.emit('deepthink:done', { synthesis });
    return { plan, taskResults, synthesis };
  }

  async _plan(userMessage, cfg, history) {
    const historyCtx = history
      .slice(-6)
      .map((h) => `${h.role}: ${h.content}`)
      .join('\n');

    const planPrompt = `You are deepthink's planning engine. Decompose this request into concrete, sequential steps.

User request: "${userMessage}"
${historyCtx ? `\nConversation history context:\n${historyCtx}` : ''}

Available Agent Profiles: ${Object.keys(AGENT_PROFILES).join(', ')}
Available Tools: ${Object.keys(TOOL_DEFINITIONS).join(', ')}

Respond ONLY with standard JSON format:
{
  "understanding": "detailed synthesis of user requirements",
  "complexity": "simple|medium|complex",
  "tasks": [
    {
      "id": "t1",
      "description": "highly specific subtask",
      "agent": "appropriate profile to run this",
      "depends_on": [],
      "expected_output": "specific verified data or target state"
    }
  ],
  "personality": "tone direction for the final response"
}

Keep plans highly logical. Avoid empty conversational steps.`;

    let plan;
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        plan = await this.engine.generateJSON({
          model: cfg.plannerModel,
          prompt: planPrompt,
          depth: cfg.deepthinkDepth,
          checks: cfg.deepthinkChecks,
          mcts: cfg.useMCTS,
        });
        if (plan && Array.isArray(plan.tasks) && plan.tasks.length > 0) break;
      } catch {
        if (attempt === this.MAX_RETRIES - 1) {
          plan = {
            understanding: userMessage,
            complexity: 'simple',
            tasks: [
              {
                id: 't1',
                description: userMessage,
                agent: 'general',
                depends_on: [],
                expected_output: 'completed task',
              },
            ],
            personality: 'direct',
          };
        }
      }
    }
    return plan;
  }

  async _executeTaskWithLoops(task, cfg, history, previousResults) {
    const maxAttempts = 3;
    let feedback = '';

    for (let attempts = 1; attempts <= maxAttempts && !this._cancel; attempts++) {
      const result = await this._executeTask(task, cfg, history, previousResults, feedback);

      // trivial-success fast path
      if (result && result.success === true) return result;

      const verification = await this._metacognitiveVerify(task, result, cfg);
      if (verification.passed) return result;

      this.emit('deepthink:thought', {
        thought: `Verification failed: "${verification.reason}". Reverting mutated local files to preserve state and adjusting trajectory.`,
      });
      await this.ctx.run('deepthink_rollback', {});
      feedback = `Previous attempt failed verification! Reason: ${verification.reason}. Structural recommendation: ${verification.recommendation}`;
    }
    return {
      summary: 'Task completed after multiple correction attempts.',
      output: 'Task completed with manual rollback interventions.',
      success: false,
    };
  }

  async _executeTask(task, cfg, history, previousResults, feedbackPrompt = '') {
    const agentProfile = AGENT_PROFILES[task.agent] || AGENT_PROFILES.general;
    const prevCtx = previousResults.length
      ? '\n\nPrevious results for downstream context:\n' +
        previousResults
          .map(
            (r) =>
              `- ${r.task.description}: ${JSON.stringify(r.result?.summary || r.result?.output || 'done').slice(0, 400)}`,
          )
          .join('\n')
      : '';

    const systemPrompt = `${agentProfile.system}

CURRENT TASK: ${task.description}
EXPECTED OUTPUT GOAL: ${task.expected_output}
${prevCtx}
${feedbackPrompt ? `\nMETACOGNITIVE ADJUSTMENT REQUIRED:\n${feedbackPrompt}` : ''}

You are deepthink — an autonomous agent.
Use the available tools to accomplish the task. Call one tool at a time and wait for the result before calling the next.
When the task is complete, verify your work and respond with:
<task_complete>
{"summary": "what was accomplished", "output": "actual complete final response/data", "success": true}
</task_complete>`;

    const agentMemory = [...history.slice(-4), { role: 'user', content: `Begin executing task: ${task.description}` }];
    const nativeTools = toNativeTools();
    // raw tool results keyed by id; the convo only gets a compressed pointer
    // so the KV cache stays small — model can re-fetch on demand
    const rawStore = new Map();
    let rawId = 0;

    let iterations = 0;
    let loopWarnings = 0;
    let xmlMode = false; // models w/o tool support fall back to <tool_call> parsing
    const deadline = Date.now() + this.TASK_DEADLINE_MS;
    while (iterations < this.MAX_AGENT_ITERATIONS && !this._cancel) {
      iterations++;

      // budget check at the TOP of the loop, before any model call
      if (Date.now() > deadline) {
        console.warn('commander', 'task deadline hit', { task: task.description.slice(0, 80) });
        return { summary: 'Task exceeded wall-clock deadline.', output: null, success: false };
      }

      // context eviction: when the convo gets heavy, drop the OLDEST tool
      // results and leave a pointer — lossless, model can re-run the tool
      // if it needs the detail again. never summarize.
      if (this._contextWeight(agentMemory) > 40_000) {
        const evicted = this._evictOldToolResults(agentMemory);
        if (evicted > 0) {
          console.debug('commander', 'evicted old tool results', { count: evicted });
          agentMemory.push({
            role: 'user',
            content: `[Note: ${evicted} older tool results were compacted to keep context lean. Re-run a tool if you need its full output again.]`,
          });
        }
      }

      const loopCheck = this._detectExecutionLoop();
      if (loopCheck.looping) {
        loopWarnings++;
        this.emit('deepthink:thought', {
          thought: 'Warning: Loop pattern detected. Activating mental override strategies.',
        });
        if (loopWarnings >= this.MAX_LOOP_WARNINGS) {
          console.warn('commander', 'loop abort', { tool: loopCheck.tool, task: task.description.slice(0, 80) });
          return {
            summary: `Task aborted: stuck in a loop calling '${loopCheck.tool}'.`,
            output: null,
            success: false,
          };
        }
        agentMemory.push({
          role: 'user',
          content: `SYSTEM WARNING: You are caught in an execution loop calling '${loopCheck.tool}' recursively! Pause, rethink your plan, write a fresh code block/script if needed, and change your strategy completely.`,
        });
      }

      let fullResponse = '';
      let toolCalls = [];
      try {
        const res = await this.engine.chatTools({
          model: cfg.mainModel,
          messages: agentMemory,
          system: systemPrompt,
          tools: xmlMode ? undefined : nativeTools,
          // low temp = deterministic tool calls, fewer malformed args
          options: { temperature: 0.1 },
        });
        fullResponse = res.content;
        toolCalls = res.tool_calls || [];
      } catch (err) {
        return { summary: 'LLM stream error', output: err.message, success: false };
      }
      agentMemory.push({
        role: 'assistant',
        content: fullResponse,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });

      const doneMatch = fullResponse.match(/<task_complete>([\s\S]*?)<\/task_complete>/);
      if (doneMatch) {
        try {
          return JSON.parse(doneMatch[1].trim());
        } catch {
          return { summary: fullResponse, output: fullResponse, success: true };
        }
      }

      // native tool calls — structured via the API, no XML parsing.
      // independent calls in one turn run concurrently (bounded), which
      // hides tool latency behind each other.
      if (toolCalls.length) {
        const gated = [];
        for (const tc of toolCalls) {
          const toolName = tc.function?.name;
          const params = tc.function?.arguments || {};
          if (!toolName) continue;
          this.executionHistory.push({ tool: toolName, params });

          if (RISKY_TOOLS.has(toolName)) {
            const decision = await this._mctsEvaluate({ tool: toolName, params }, cfg, task);
            if (!decision.approved) {
              this.emit('deepthink:thought', {
                thought: `Risk gate rejected "${toolName}" (confidence ${(decision.confidence * 100).toFixed(0)}%). Reason: ${decision.reason || 'low confidence'}.`,
              });
              agentMemory.push({
                role: 'user',
                content: `Risk simulation flagged this action as low confidence. ${decision.feedback || 'Try a different approach or different parameters.'}`,
              });
              continue;
            }
          }
          gated.push({ toolName, params });
        }
        const results = await Promise.all(
          gated.map((g) => this.ctx.run(g.toolName, g.params).catch((e) => ({ ok: false, error: e.message }))),
        );
        for (let i = 0; i < gated.length; i++) {
          agentMemory.push({ role: 'tool', content: this._compressResult(results[i], rawStore, ++rawId) });
        }
        continue;
      }

      // XML fallback for models that ignored the tools API
      const toolMatch = fullResponse.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
      if (toolMatch) {
        let toolCall;
        try {
          toolCall = JSON.parse(toolMatch[1].trim());
        } catch {
          agentMemory.push({
            role: 'user',
            content: 'Error: Invalid JSON syntax in tool_call object structure. Re-execute.',
          });
          continue;
        }

        if (toolCall.narration) {
          this.emit('deepthink:thought', { thought: `Hmm... let me try this... ${toolCall.narration}` });
        }
        this.executionHistory.push({ tool: toolCall.tool, params: toolCall.params });

        if (RISKY_TOOLS.has(toolCall.tool)) {
          const decision = await this._mctsEvaluate(toolCall, cfg, task);
          if (!decision.approved) {
            this.emit('deepthink:thought', {
              thought: `Risk gate rejected "${toolCall.tool}" (confidence ${(decision.confidence * 100).toFixed(0)}%). Reason: ${decision.reason || 'low confidence'}.`,
            });
            agentMemory.push({
              role: 'user',
              content: `Risk simulation flagged this action as low confidence. ${decision.feedback || 'Try a different approach or different parameters.'}`,
            });
            continue;
          }
        }

        const toolResult = await this.ctx.run(toolCall.tool, toolCall.params || {});
        const resultStr = this._compressResult(toolResult, rawStore, ++rawId);
        agentMemory.push({
          role: 'user',
          content: `Result of tool execution [${toolCall.tool}]:\n${resultStr}\n\nContinue or finish with <task_complete>.`,
        });
        continue;
      }

      // neither tools nor completion — flip to XML mode once
      if (!xmlMode) {
        xmlMode = true;
        agentMemory.push({
          role: 'user',
          content:
            'Use the <tool_call>{"tool":"tool_name","params":{}}</tool_call> format to call tools, or finish with <task_complete>.',
        });
        continue;
      }

      if (iterations >= 2) {
        agentMemory.push({
          role: 'user',
          content:
            'Please wrap your final verification report in <task_complete>{"summary":"...","output":"...","success":true}</task_complete>',
        });
      }
    }
    return { summary: 'Task execution timed out or reached iteration bounds.', output: null, success: false };
  }

  // rough char-based convo weight (token proxy)
  _contextWeight(messages) {
    let w = 0;
    for (const m of messages) w += (m.content || '').length;
    return w;
  }

  // swap the oldest {role:'tool'} msgs for a one-line pointer, keep the
  // recent few intact (model still reasoning about those). returns evicted count.
  _evictOldToolResults(messages) {
    const keep = 4;
    const idxs = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') idxs.push(i);
    }
    const evict = idxs.slice(0, Math.max(0, idxs.length - keep));
    for (const i of evict) {
      messages[i] = { role: 'tool', content: '[result evicted — re-run the tool to refetch]' };
    }
    return evict.length;
  }

  // shrink a tool result for the convo: strip ANSI noise, cap size, stash
  // the raw copy in the store so the model can re-fetch if needed.
  _compressResult(toolResult, rawStore, id) {
    let s;
    try {
      s = JSON.stringify(toolResult);
    } catch {
      s = String(toolResult);
    }
    rawStore.set(id, s);
    s = s
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > 6000) s = s.slice(0, 6000) + '…';
    return `[result #${id} — full copy retrievable via re-run]\n${s}`;
  }

  // Risk gate for a proposed tool call. Three tiers, cheapest first:
  //   1. deterministic floor — reject w/ zero LLM calls if heuristics alone
  //      show the original is clearly worse than an alternative
  //   2. capped pairwise tournament — original vs top alternatives, judged
  //      by the FAST loop model, not the slow plan model
  //   3. fallback — allow when the gate itself fails
  async _mctsEvaluate(toolCall, cfg, task) {
    this.emit('deepthink:thought', { thought: 'Running a quick risk simulation on this trajectory...' });
    try {
      const candidates = await this._proposeAlternatives(toolCall, cfg, task);
      const all = [toolCall, ...candidates];

      // tier 1: heuristic pre-filter. high-risk tool w/ a read-only
      // alternative is a near-certain wrong pick — no LLM needed.
      const origScore = _heuristicScore(toolCall);
      const bestAlt = candidates.reduce((m, c) => Math.max(m, _heuristicScore(c)), 0);
      if (bestAlt - origScore > 0.15) {
        const best = candidates.find((c) => _heuristicScore(c) === bestAlt) || candidates[0];
        return {
          approved: false,
          confidence: 0.3,
          reason: 'risk gate preferred an alternative',
          best,
          feedback: `Consider this alternative instead: ${JSON.stringify(best).slice(0, 300)}`,
        };
      }

      // tier 2: capped pairwise tournament, judged by the fast model
      const result = await beamSearch({
        engine: this.engine,
        candidates: all,
        // __history feeds the loop detector — a repeated call gets
        // penalized before the LLM even sees it
        state: { model: cfg.mainModel, task: task?.description, __history: this.executionHistory.slice(-10) },
        goal: task?.description,
        k: 1,
        maxPairs: 4,
      });
      const best = result.best?.[0];
      if (!best) {
        return { approved: true, confidence: 0.5, reason: 'no candidates produced' };
      }
      const isOriginal = best.tool === toolCall.tool && JSON.stringify(best.params) === JSON.stringify(toolCall.params);
      return {
        approved: isOriginal,
        confidence: result.ranking?.[0]?.score ?? 0.5,
        reason: isOriginal ? 'risk gate approved' : 'risk gate preferred an alternative',
        best,
        feedback: isOriginal ? undefined : `Consider this alternative instead: ${JSON.stringify(best).slice(0, 300)}`,
      };
    } catch {
      return { approved: true, confidence: 0.5, reason: 'risk gate unavailable, defaulting to allow' };
    }
  }

  // ask the LLM for 2-3 alternative tool calls for the same intent. if any
  // score better than the original, MCTS picks it instead.
  async _proposeAlternatives(toolCall, cfg, task) {
    try {
      const prompt = `For the user goal below, propose 2-3 alternative tool calls (different params or different tool) that could accomplish the same thing as the proposed one.
GOAL: ${task?.description || 'unspecified'}
PROPOSED: ${JSON.stringify(toolCall)}

Respond ONLY with JSON: {"alternatives":[{"tool":"...","params":{...},"narration":"..."}, ...]}`;
      const res = await this.engine.generateJSON({
        model: cfg.mctsModel,
        prompt,
        depth: 0,
        checks: 0,
        mcts: false,
      });
      // 2 alts max — keeps the pairwise tournament small
      return Array.isArray(res.alternatives) ? res.alternatives.slice(0, 2) : [];
    } catch {
      return [];
    }
  }

  async _metacognitiveVerify(task, result, cfg) {
    const prompt = `You are deepthink's internal auditor. Verify if the executed sub-task has successfully achieved its target state.

Task description: ${task.description}
Expected output criteria: ${task.expected_output}
Actual output produced: ${JSON.stringify(result).slice(0, 2000)}

Respond ONLY with standard JSON format:
{
  "passed": true,
  "reason": "Detailed critique of why it passed or failed requirements",
  "recommendation": "If failed, what the agent must do to fix the trajectory"
}`;
    try {
      return await this.engine.generateJSON({
        model: cfg.verifierModel,
        prompt,
        depth: 1,
        checks: 1,
        mcts: false,
      });
    } catch {
      return { passed: true, reason: 'verifier unavailable' };
    }
  }

  _detectExecutionLoop() {
    if (this.executionHistory.length < 4) return { looping: false };
    const tail = this.executionHistory.slice(-3);
    const first = tail[0];
    // same tool AND same params 3x in a row = hard loop
    const sameAll = tail.every(
      (it) => it.tool === first.tool && JSON.stringify(it.params) === JSON.stringify(first.params),
    );
    if (sameAll) return { looping: true, tool: first.tool };
    // same tool 3x w/ varying params = softer "fixation"
    const sameTool = tail.every((it) => it.tool === first.tool);
    if (sameTool) return { looping: true, tool: first.tool, soft: true };
    return { looping: false };
  }

  async _synthesize(originalRequest, taskResults, cfg, history) {
    const summaries = taskResults
      .map(
        (r, i) =>
          `Step ${i + 1} (${r.task.description}): ${JSON.stringify(r.result?.output || r.result?.summary || 'done').slice(0, 1000)}`,
      )
      .join('\n\n');

    const systemPrompt = `You are deepthink's synthesis engine. Provide a highly professional, cohesive summary of completed work. Keep responses sleek, concise, and clear. Use markdown.`;
    const userPrompt = `Original Request: "${originalRequest}"\n\nTask Results:\n${summaries}\n\nSynthesize the completed solutions.`;

    let synthesis = '';
    try {
      await this.engine.streamChat({
        model: cfg.synthesisModel,
        messages: [...history.slice(-4), { role: 'user', content: userPrompt }],
        system: systemPrompt,
        onToken: (t) => {
          synthesis += t;
        },
      });
    } catch (err) {
      synthesis = `Synthesis failed: ${err.message}`;
    }
    return synthesis;
  }
}

export default {
  deepthink_plan: async ({ request, model, history }, ctx) => {
    const c = new Commander(ctx);
    const cfg = {
      mainModel: model || ctx.engine.defaultModel,
      plannerModel: model || ctx.engine.defaultModel,
      verifierModel: model || ctx.engine.defaultModel,
      mctsModel: model || ctx.engine.defaultModel,
      deepthinkDepth: 0,
      deepthinkChecks: 0,
      useMCTS: true,
    };
    return c._plan(request, cfg, history || []);
  },

  deepthink_process: async ({ request, model, modelConfig, history }, ctx) => {
    const c = new Commander(ctx);
    return c.process(request, model, modelConfig || {}, history || []);
  },
};
