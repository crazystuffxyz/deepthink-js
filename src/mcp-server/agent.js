// src/mcp-server/agent.js
// graph-based agent runtime. a "program" is a JSON object of named nodes
// + a starting node; each node advances the shared `state` and picks the next.
// all engine/tool/js work goes through the shared ctx — no direct ollama.
class AgentRuntime {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // resolve `a.b.c` against an object
  _get(obj, dotPath) {
    return dotPath.split('.').reduce((cur, key) => {
      if (cur === undefined || cur === null) return undefined;
      return cur[key];
    }, obj);
  }

  // substitute {{var}} and {{a.b.c}} references in any string/array/object
  _interpolate(value, state) {
    if (typeof value === 'string') {
      return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const v = this._get(state, path.trim());
        return v !== undefined ? (typeof v === 'string' ? v : JSON.stringify(v)) : '';
      });
    }
    if (Array.isArray(value)) return value.map((v) => this._interpolate(v, state));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = this._interpolate(value[k], state);
      return out;
    }
    return value;
  }

  _mergeState(state, patch) {
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      Object.assign(state, patch);
    }
  }

  // run JS in a pooled worker subprocess so agent code can't corrupt
  // host state. state is JSON-serialized into scope; mutations get
  // serialized back and merged into the parent — even when it throws.
  async _evalJS(code, state) {
    const r = await this.ctx.pool.eval(code, state, { timeout: 15000 });
    // merge mutations back even on error so retries see prior progress
    if (r.state && typeof r.state === 'object') {
      for (const k of Object.keys(r.state)) {
        if (state[k] !== r.state[k]) state[k] = r.state[k];
      }
    }
    if (!r.ok) throw new Error(`JS eval error: ${r.error}`);
    return r.result;
  }

  async _evalCondition(expr, state) {
    const r = await this._evalJS(`return !!(${expr});`, state);
    return Boolean(r);
  }

  async _evalExpression(expr, state) {
    return this._evalJS(`return (${expr});`, state);
  }

  // critic should judge on a different model than the generator — a model
  // grading its own output is a rubber stamp. prefer a non-default model.
  async _pickCriticModel() {
    try {
      const r = await this.ctx.engine.listModels();
      const names = (r.models || []).map((m) => m.name);
      if (!names.length) return this.ctx.engine.defaultModel;
      return names.find((n) => n !== this.ctx.engine.defaultModel) || this.ctx.engine.defaultModel;
    } catch {
      return this.ctx.engine.defaultModel;
    }
  }

  // --- node executors ------------------------------------------------------

  async _execLlm(node, state) {
    const prompt = this._interpolate(node.prompt, state);
    const model = this._interpolate(node.model || '', state) || this.ctx.engine.defaultModel;
    const system = node.system ? this._interpolate(node.system, state) : undefined;
    const depth = node.depth !== undefined ? Number(node.depth) : 1;
    const checks = node.checks !== undefined ? Number(node.checks) : 0;
    const mcts = node.mcts !== undefined ? Boolean(node.mcts) : false;
    const asJson = Boolean(node.json);
    const storeAs = node.storeAs || 'llm_result';
    const outputType = node.outputType || node.resultType || 'string';

    // cache key on prompt+config — repeated identical calls skip the LLM
    if (node.cacheKey) {
      const cached = state.__cache?.[node.cacheKey];
      if (cached) {
        const patch = {};
        patch[storeAs] = cached;
        return patch;
      }
    }

    const body = system ? `${system}\n\n${prompt}` : prompt;
    const result = asJson
      ? await this.ctx.engine.generateJSON(body, { model, depth, checks, mcts })
      : await this.ctx.engine.generate(body, { model, type: outputType, depth, checks, mcts });

    if (node.cacheKey) {
      state.__cache = state.__cache || {};
      state.__cache[node.cacheKey] = result;
    }
    const patch = {};
    patch[storeAs] = result;
    return patch;
  }

  async _execTool(node, state) {
    const toolName = this._interpolate(node.tool, state);
    const rawParams = node.params ? this._interpolate(node.params, state) : {};
    const storeAs = node.storeAs || 'tool_result';

    if (!toolName) throw new Error(`tool node: missing "tool" field`);

    if (node.cacheKey) {
      const cached = state.__cache?.[node.cacheKey];
      if (cached !== undefined) {
        const patch = {};
        patch[storeAs] = cached;
        return patch;
      }
    }

    const parsed = await this.ctx.run(toolName, rawParams);

    if (node.cacheKey) {
      state.__cache = state.__cache || {};
      state.__cache[node.cacheKey] = parsed;
    }

    const patch = {};
    patch[storeAs] = parsed;
    return patch;
  }

  async _execJs(node, state) {
    const code = node.code;
    const result = await this._evalJS(code, state);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result;
    }
    const storeAs = node.storeAs || 'js_result';
    const patch = {};
    patch[storeAs] = result;
    return patch;
  }

  async _execRegex(node, state) {
    const input = this._interpolate(node.input, state);
    const pattern = this._interpolate(node.pattern, state);
    const flags = node.flags || '';
    const mode = node.mode || 'match';
    const storeAs = node.storeAs || 'regex_result';
    const patch = {};

    const re = new RegExp(pattern, flags);

    if (mode === 'match') {
      const m = input.match(re);
      patch[storeAs] = m ? (m.groups || m.slice(1).length ? m.groups || m.slice(1) : m[0]) : null;
    } else if (mode === 'matchAll') {
      const matches = [...input.matchAll(re)].map((m) => m.groups || m.slice(1));
      patch[storeAs] = matches;
    } else if (mode === 'replace') {
      const replacement = this._interpolate(node.replacement || '', state);
      patch[storeAs] = input.replace(re, replacement);
    } else if (mode === 'test') {
      patch[storeAs] = re.test(input);
    } else if (mode === 'split') {
      patch[storeAs] = input.split(re);
    } else if (mode === 'extract') {
      const m = input.match(re);
      if (m && node.groups && typeof node.groups === 'object') {
        for (const [alias, idx] of Object.entries(node.groups)) {
          patch[alias] = m[idx] !== undefined ? m[idx] : null;
        }
      } else {
        patch[storeAs] = m ? m[0] : null;
      }
    }
    return patch;
  }

  async _execSet(node, state) {
    const patch = {};
    for (const [key, value] of Object.entries(node.values || {})) {
      patch[key] = this._interpolate(value, state);
    }
    return patch;
  }

  async _execTap(node, state, ctx) {
    // tap = side-effect-only node. logs a snapshot and continues.
    if (node.message) {
      const msg = this._interpolate(node.message, state);
      const entry = { type: 'tap', step: ctx.steps, message: msg, state: { ...state } };
      ctx.log.push(entry);
      this.ctx.pushLog(entry);
      if (ctx.onStep) ctx.onStep({ phase: 'tap', message: msg, state: { ...state } });
    }
    return {};
  }

  async _execTry(node, state, ctx) {
    try {
      return await this._runGraph(node.body, state, ctx);
    } catch (err) {
      const patch = {};
      patch[storeAs_try(node)] = { error: err.message };
      patch.__tryCaught = true;
      if (node.errorKey) patch[node.errorKey] = err.message;
      if (node.recoverState) {
        Object.assign(patch, this._interpolate(node.recoverState, state));
      }
      return patch;
    }
  }

  async _execCritiqueLoop(node, state, ctx) {
    // research: cap at 2-3 iterations — more just re-rolls the same dice
    const maxIter = Math.min(node.maxIterations || 3, 20);
    const storeAs = node.storeAs || 'critique_result';
    const passKey = node.passKey || 'critique_passed';
    const reasonKey = node.reasonKey || 'critique_reason';

    // generator is a sub-graph { entry, nodes, state } — give it its own
    // ctx so inner node names don't collide with the parent's
    const gen = node.generator || {};
    const genEntry = gen.entry || Object.keys(gen.nodes || {})[0];
    const genCtx = {
      ...ctx,
      nodes: { ...ctx.nodes, ...(gen.nodes || {}) },
      steps: 0,
      done: false,
      log: [],
    };

    // full state snapshot before the generator runs. each trial restores
    // everything the generator touched — no leaked keys from attempt N
    // polluting attempt N+1
    const snapshot = JSON.parse(JSON.stringify(state));
    // episodic memory: every critique text, not just the latest verdict
    const feedbackHistory = [];
    // loop-managed keys survive the per-trial restore
    const managed = new Set([passKey, reasonKey, 'critique_feedback', 'critique_history']);
    if (node.repairPromptKey) managed.add(node.repairPromptKey);

    for (let iter = 0; iter < maxIter; iter++) {
      // restore snapshot (loop-managed keys survive)
      for (const k of Object.keys(state)) {
        if (managed.has(k)) continue;
        delete state[k];
      }
      Object.assign(state, JSON.parse(JSON.stringify(snapshot)));
      genCtx.done = false;
      genCtx.steps = 0;
      await this._runGraph(genEntry, state, genCtx);

      let criticModel = this._interpolate(node.criticModel || '', state);
      if (!criticModel) {
        criticModel = await this._pickCriticModel();
      }
      const criticPrompt = this._interpolate(
        node.criticPrompt ||
          'Evaluate the result against the task. Your critique MUST cite the specific step/output segment and state the exact required change. Respond with JSON {passed: bool, reason: string, feedback: string} where feedback is specific and actionable.',
        state,
      );
      const generatedKey = node.generatedKey || 'llm_result';
      const generated = state[generatedKey] || '';

      const fullCriticPrompt = `${criticPrompt}\n\nContent to evaluate:\n${typeof generated === 'string' ? generated : JSON.stringify(generated, null, 2)}`;

      let verdict;
      try {
        verdict = await this.ctx.engine.generateJSON(fullCriticPrompt, {
          model: criticModel,
          depth: node.criticDepth !== undefined ? Number(node.criticDepth) : 1,
          checks: node.criticChecks !== undefined ? Number(node.criticChecks) : 0,
          mcts: false,
        });
      } catch {
        verdict = { passed: false, reason: 'Critic failed to produce valid JSON', feedback: '' };
      }

      state[passKey] = Boolean(verdict.passed);
      state[reasonKey] = verdict.reason || '';

      // accumulate — next trial sees ALL prior critiques, not just one
      feedbackHistory.push(verdict.feedback || verdict.reason || 'no feedback');
      state.critique_feedback = feedbackHistory[feedbackHistory.length - 1];
      state.critique_history = [...feedbackHistory];

      if (verdict.passed) {
        const patch = {};
        patch[storeAs] = state[generatedKey];
        return patch;
      }
      if (node.repairPromptKey && feedbackHistory.length) {
        state[node.repairPromptKey] = `Previous attempts failed critique. Accumulated feedback:\n${feedbackHistory
          .map((f, i) => `${i + 1}. ${f}`)
          .join(
            '\n',
          )}\n\nCorrect your output implementing ONLY the changes listed above — no new facts, no scope creep.`;
      }
    }

    const patch = {};
    patch[storeAs] = state[node.generatedKey || 'llm_result'];
    state[passKey] = false;
    return patch;
  }

  async _execParallel(node, state, ctx) {
    const nodeNames = node.nodes || [];
    const stateCopy = JSON.parse(JSON.stringify(state));

    const results = await Promise.all(
      nodeNames.map(async (nodeName) => {
        const branchState = JSON.parse(JSON.stringify(stateCopy));
        const branchCtx = {
          nodes: ctx.nodes,
          maxSteps: ctx.maxSteps,
          maxLoopIterations: ctx.maxLoopIterations,
          steps: ctx.steps,
          done: false,
          log: [],
          onStep: ctx.onStep,
        };
        try {
          await this._runGraph(nodeName, branchState, branchCtx);
        } catch (err) {
          branchCtx.log.push({ error: err.message, node: nodeName });
        }
        return { state: branchState, steps: branchCtx.steps, log: branchCtx.log };
      }),
    );

    // merge child step counts/log into parent ctx
    ctx.steps = results.reduce((m, r) => Math.max(m, r.steps), ctx.steps);
    for (const r of results) {
      ctx.log.push(...r.log);
      for (const e of r.log) this.ctx.pushLog(e);
    }

    // merge new keys (anything not already in stateCopy)
    const patch = {};
    for (const r of results) {
      for (const key of Object.keys(r.state)) {
        if (!(key in stateCopy)) patch[key] = r.state[key];
      }
    }
    if (node.storeAs && node.collectKey) {
      patch[node.storeAs] = results.map((r) => r.state[node.collectKey] ?? null);
    }
    return patch;
  }

  // --- dispatch -----------------------------------------------------------

  async _execNode(nodeName, state, ctx) {
    const node = ctx.nodes[nodeName];
    if (!node) throw new Error(`Agent node not found: "${nodeName}"`);

    ctx.steps++;
    if (ctx.steps > ctx.maxSteps) {
      throw new Error(`Agent exceeded maxSteps (${ctx.maxSteps}). Execution halted.`);
    }

    const stepEntry = {
      step: ctx.steps,
      node: nodeName,
      type: node.type,
      ts: Date.now(),
      status: 'running',
    };
    ctx.log.push(stepEntry);
    this.ctx.pushLog(stepEntry);
    if (ctx.onStep) ctx.onStep({ ...stepEntry, phase: 'start', state: { ...state } });

    let patch = {};
    let nextNode;

    const runOnce = async () => {
      switch (node.type) {
        case 'llm':
          patch = await this._execLlm(node, state);
          this._mergeState(state, patch);
          return node.next || null;
        case 'tool':
          patch = await this._execTool(node, state);
          this._mergeState(state, patch);
          return node.next || null;
        case 'js':
          patch = await this._execJs(node, state);
          this._mergeState(state, patch);
          return node.next || null;
        case 'regex':
          patch = await this._execRegex(node, state);
          this._mergeState(state, patch);
          return node.next || null;
        case 'set':
          patch = await this._execSet(node, state);
          this._mergeState(state, patch);
          return node.next || null;
        case 'tap':
          await this._execTap(node, state, ctx);
          return node.next || null;
        case 'try': {
          patch = await this._execTry(node, state, ctx);
          this._mergeState(state, patch);
          return patch.__tryCaught ? node.catch || node.next || null : node.next || null;
        }
        case 'if': {
          const cond = await this._evalCondition(node.condition, state);
          return cond ? node.then || null : node.else || null;
        }
        case 'while': {
          let loopCount = 0;
          while (await this._evalCondition(node.condition, state)) {
            loopCount++;
            if (loopCount > ctx.maxLoopIterations) {
              throw new Error(`while node "${nodeName}" exceeded maxLoopIterations (${ctx.maxLoopIterations})`);
            }
            ctx.steps++;
            if (ctx.steps > ctx.maxSteps) {
              throw new Error(`Agent exceeded maxSteps (${ctx.maxSteps})`);
            }
            await this._runGraph(node.body, state, ctx);
            if (ctx.done) break;
          }
          return node.next || null;
        }
        case 'for': {
          const arrayKey = node.arrayKey || 'items';
          const itemKey = node.itemKey || 'item';
          const indexKey = node.indexKey || 'index';
          const arr = state[arrayKey];
          if (!Array.isArray(arr)) {
            throw new Error(`for node "${nodeName}": state.${arrayKey} is not an array`);
          }
          for (let i = 0; i < arr.length; i++) {
            if (i >= ctx.maxLoopIterations) {
              throw new Error(`for node "${nodeName}" exceeded maxLoopIterations (${ctx.maxLoopIterations})`);
            }
            ctx.steps++;
            if (ctx.steps > ctx.maxSteps) {
              throw new Error(`Agent exceeded maxSteps (${ctx.maxSteps})`);
            }
            state[itemKey] = arr[i];
            state[indexKey] = i;
            await this._runGraph(node.body, state, ctx);
            if (ctx.done) break;
          }
          return node.next || null;
        }
        case 'switch': {
          const switchVal = String(await this._evalExpression(node.expression, state));
          return (node.cases || {})[switchVal] || node.default || null;
        }
        case 'goto':
          return node.target || null;
        case 'critique_loop':
          patch = await this._execCritiqueLoop(node, state, ctx);
          this._mergeState(state, patch);
          return node.next || null;
        case 'parallel':
          patch = await this._execParallel(node, state, ctx);
          this._mergeState(state, patch);
          return node.next || null;
        case 'return': {
          if (node.value !== undefined) {
            state.__output = this._interpolate(node.value, state);
          } else if (node.fromKey) {
            state.__output = state[node.fromKey];
          }
          ctx.done = true;
          return null;
        }
        default:
          throw new Error(`Unknown agent node type: "${node.type}" on node "${nodeName}"`);
      }
    };

    try {
      const attempts = Math.max(1, node.retries || 1);
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        try {
          nextNode = await runOnce();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (i < attempts - 1) {
            state[node.retryKey || 'last_retry_error'] = err.message;
          }
        }
      }
      if (lastErr) throw lastErr;

      stepEntry.status = 'success';
      stepEntry.patch = patch;
      stepEntry.next = nextNode;
      if (ctx.onStep) ctx.onStep({ ...stepEntry, phase: 'end', state: { ...state } });
      return nextNode;
    } catch (err) {
      stepEntry.status = 'error';
      stepEntry.error = err.message;
      if (ctx.onStep) ctx.onStep({ ...stepEntry, phase: 'end', state: { ...state } });
      throw err;
    }
  }

  async _runGraph(startNode, state, ctx) {
    let current = startNode;
    let safety = 0;
    while (current && !ctx.done) {
      if (++safety > 1000) {
        throw new Error('runGraph: exceeded safety bound (1000 hops) — likely a cycle without termination');
      }
      const next = await this._execNode(current, state, ctx);
      current = next;
    }
  }

  async run(program, onStep) {
    const nodes = program.nodes || {};
    const state = JSON.parse(JSON.stringify(program.state || {}));
    const entry = program.entry || Object.keys(nodes)[0];
    const maxSteps = Math.min(program.maxSteps || 200, 2000);
    const maxLoopIterations = Math.min(program.maxLoopIterations || 50, 500);

    const ctx = {
      nodes,
      maxSteps,
      maxLoopIterations,
      steps: 0,
      done: false,
      log: [],
      onStep,
    };
    const startTime = Date.now();

    try {
      await this._runGraph(entry, state, ctx);
    } catch (err) {
      state.__error = err.message;
      state.__aborted = true;
    }

    return {
      output: state.__output ?? null,
      state,
      steps: ctx.steps,
      log: ctx.log,
      aborted: state.__aborted || false,
      error: state.__error || null,
      durationMs: Date.now() - startTime,
    };
  }
}

function storeAs_try(node) {
  return node.storeAs || 'try_result';
}

// the single exported tool. wraps the runtime on the shared ctx.
async function deepthink_agent(args, ctx) {
  const { program, onStep } = args || {};
  const rt = new AgentRuntime(ctx);
  return rt.run(program, onStep);
}

export default { deepthink_agent };
