// thinking/deepthink.js
'use strict';

import { Ollama } from 'ollama';
import { stripThinkBlocks, stripCodeFences, parseDataType, cloneMessage, messagesToText, normalizeInputToMessages, createDefaultSystemPrompt } from './dataTypes.js';
import { runThink } from './think.js';
import { analyzeAndSolve } from './analytical.js';
import { generateAndRunCode, compareResults, PYTHON_BIN } from './codeGenerator.js';
import { buildProviderClient } from '../providers/index.js';
import { runCognitiveFlow } from './cognitive.js';
import { selfConsistency } from './consistency.js';
import { runDebate } from './personaDebate.js';
import { runPlanAndExecute } from './planAndExecute.js';
import { attachReflexion } from './reflexion.js';
import { compress, truncateMiddle } from './smartCompression.js';
import { toolLoop, DEFAULT_TOOLS } from './toolUse.js';
import { runMoA } from './mixtureOfAgents.js';
import { makeCalibrator } from './confidence.js';
import { evolvePrompts, applyEvolvedPrompt, loadBest } from './evolvedThinking.js';

const sandbox = '\x00SANDBOX_GT\x00';
const qwen = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  repeat_penalty: 1.05
};
const SAMPLING = {
  code: {
    temperature: 0.1,
    top_p: 0.8,
    top_k: 20,
    repeat_penalty: 1.05
  },
  json: {
    temperature: 0.0,
    top_p: 1.0,
    top_k: 1,
    repeat_penalty: 1.0
  },
  creative: {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    repeat_penalty: 1.05
  },
  reasoning: {
    temperature: 0.6,
    top_p: 0.8,
    top_k: 20,
    repeat_penalty: 1.05
  },
  verify: {
    temperature: 0.0,
    top_p: 1.0,
    top_k: 1,
    repeat_penalty: 1.0
  },
  planning: {
    temperature: 0.5,
    top_p: 0.85,
    top_k: 30,
    repeat_penalty: 1.05
  }
};
class Async {
  constructor() {
    this._chain = Promise.resolve();
  }
  run(fn) {
    const n = this._chain.then(() => fn());
    this._chain = n.catch(() => {});
    return n;
  }
}
class P {
  constructor(c) {
    this._c = c;
    this._r = 0;
    this._q = [];
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      const exec = async () => {
        this._r++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          this._r--;
          if (this._q.length) this._q.shift()();
        }
      };
      this._r < this._c ? exec() : this._q.push(exec);
    });
  }
}
class Brain {
  constructor(maxItems = 7) {
    this.maxItems = maxItems;
    this.workingMemory = [];
    this.semanticMemory = '';
    this.consolidations = 0;
  }
  add(type, content, priority = 5) {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    this.workingMemory.push({
      id: `wm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      priority: Math.max(1, Math.min(10, priority)),
      content: raw,
      timestamp: Date.now(),
      _failCount: 0
    });
  }
  isOverCapacity() {
    return this.workingMemory.length > this.maxItems;
  }
  evict() {
    if (!this.isOverCapacity()) return [];
    const sorted = [...this.workingMemory].sort((a, b) => a.priority - b.priority);
    const toEvict = sorted.slice(0, this.workingMemory.length - this.maxItems);
    const ids = new Set(toEvict.map(i => i.id));
    this.workingMemory = this.workingMemory.filter(i => !ids.has(i.id));
    return toEvict;
  }
  appendToSemantic(s) {
    this.semanticMemory += (this.semanticMemory ? '\n---\n' : '') + String(s);
    this.consolidations++;
  }
  getContextBlock() {
    const parts = [];
    if (this.semanticMemory) parts.push(`[SEMANTIC MEMORY]\n${this.semanticMemory}`);
    if (this.workingMemory.length) parts.push(`[WORKING MEMORY (${this.workingMemory.length}/${this.maxItems})]\n${JSON.stringify(this.workingMemory, null, 2)}`);
    return parts.join('\n\n');
  }
  spawnAgent(label = '') {
    const a = new Brain(this.maxItems);
    a.semanticMemory = this.semanticMemory ? `[INHERITED${label ? ': ' + label : ''}]\n${this.semanticMemory}` : '';
    a.workingMemory = this.workingMemory.map(i => ({
      ...i
    }));
    return a;
  }
}
class Metacognitive {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 5;
    this.similarityThreshold = opts.similarityThreshold ?? 0.82;
    this.maxSameFeedback = opts.maxSameFeedback ?? 2;
    this._rHist = [];
    this._fHist = [];
    this.interventions = 0;
    this._best = null;
    this._bestScore = -Infinity;
  }
  _score(text, passed = 0) {
    return passed * 10 + Math.min(text.trim().length, 200) / 200;
  }
  updateBest(text, passed = 0) {
    const s = this._score(text, passed);
    if (s > this._bestScore) {
      this._bestScore = s;
      this._best = text;
    }
  }
  _jaccard(a, b, n = 4) {
    const g = s => {
      const st = new Set(),
        norm = s.toLowerCase().replace(/\s+/g, ' ');
      for (let i = 0; i <= norm.length - n; i++) st.add(norm.slice(i, i + n));
      return st;
    };
    const ga = g(a),
      gb = g(b);
    if (!ga.size && !gb.size) return 1;
    if (!ga.size || !gb.size) return 0;
    let inter = 0;
    for (const x of ga)
      if (gb.has(x)) inter++;
    return inter / (ga.size + gb.size - inter);
  }
  trackResponse(text) {
    const key = text.trim().replace(/\s+/g, ' ');
    this._rHist.push(key);
    if (this._rHist.length > this.windowSize) this._rHist.shift();
    return this._rHist.length >= 2 && this._rHist.slice(0, -1).some(p => this._jaccard(key, p) > this.similarityThreshold);
  }
  trackFeedback(failed) {
    const key = failed.map(f => f.feedback || '').sort().join('||');
    this._fHist.push(key);
    if (this._fHist.length > this.maxSameFeedback + 1) this._fHist.shift();
    const win = this._fHist.slice(-this.maxSameFeedback);
    return win.length >= this.maxSameFeedback && win.every(f => this._jaccard(f, key, 3) > 0.72);
  }
  interrupt(current) {
    this.interventions++;
    console.warn(`\x1b[33m[METACOGNITIVE INTERRUPT #${this.interventions}] Returning best response.\x1b[0m`);
    return this._best || current;
  }
  reset() {
    this._rHist = [];
    this._fHist = [];
    this._best = null;
    this._bestScore = -Infinity;
  }
}

function consolidateSystemMessages(messages) {
  const sandboxMsgs = [],
    regular = [],
    nonSys = [];
  for (const m of messages) {
    if (m.role !== 'system') {
      nonSys.push(m);
      continue;
    }
    m.content.startsWith(sandbox) ? sandboxMsgs.push(m) : regular.push(m);
  }
  const out = sandboxMsgs.map(m => ({
    role: 'system',
    content: m.content.slice(sandbox.length)
  }));
  if (regular.length) {
    const merged = regular.map(m => m.content).join('\n\n---\n\n');
    out.push({
      role: 'system',
      content: merged
    });
  }
  return [...out, ...nonSys.map(cloneMessage)];
}

function insertSystemPrompt(messages, sys) {
  if (!sys) return messages.map(cloneMessage);
  return [{
    role: 'system',
    content: sys
  }, ...messages.map(cloneMessage)];
}
class Deepthink {
  constructor(model, apiKeys = [], clientOptions = {}, concurrency = Infinity, auditModel = null) {
    this.model = model || process.env.OLLAMA_MODEL || 'llama3.1';
    this.auditModel = auditModel || this.model;
    this.apiKeys = Array.isArray(apiKeys) ? apiKeys.map(k => String(k).trim()).filter(Boolean) : [];
    this.currentKeyIndex = 0;
    this.clientOptions = clientOptions || {};
    this.limiter = new P(concurrency);
    this._keyFailures = new Map();
    this._keyMutex = new Async();
  }
  async getNextApiKey() {
    return this._keyMutex.run(() => {
      if (!this.apiKeys.length) return null;
      const now = Date.now();
      for (let i = 0; i < this.apiKeys.length; i++) {
        const idx = (this.currentKeyIndex + i) % this.apiKeys.length;
        const key = this.apiKeys[idx];
        const rec = this._keyFailures.get(key);
        if (!rec || now > (rec.quarantineUntil || 0)) {
          this.currentKeyIndex = (idx + 1) % this.apiKeys.length;
          return key;
        }
      }
      let soonest = null,
        t = Infinity;
      for (const [k, r] of this._keyFailures)
        if ((r.quarantineUntil || 0) < t) {
          t = r.quarantineUntil;
          soonest = k;
        }
      return soonest;
    });
  }
  _markKeyFailure(key) {
    if (!key) return;
    this._keyMutex.run(() => {
      const rec = this._keyFailures.get(key) || {
        count: 0,
        quarantineUntil: 0
      };
      if (++rec.count >= 2) rec.quarantineUntil = Date.now() + 60_000;
      this._keyFailures.set(key, rec);
    });
  }
  _markKeySuccess(key) {
    if (key) this._keyFailures.delete(key);
  }
  buildClient(key) {
    const providerOpts = this.clientOptions.provider ? this.clientOptions : {
      provider: 'ollama',
      ...this.clientOptions
    };
    return buildProviderClient(providerOpts, key);
  }
  normalizeMessages(input, opts = {}) {
    const messages = normalizeInputToMessages(input);
    if (!opts.autoSystemPrompt) return messages;
    const sys = typeof opts.systemPrompt === 'string' ? opts.systemPrompt.trim() : '';
    return insertSystemPrompt(messages, sys || createDefaultSystemPrompt(opts.type || 'string', opts.depth ?? 0));
  }
  async callChat(messages, stream = false, onChunk = null, opts = {}) {
    if (opts.autoChoose) {
      let validSettings = null;
      while (!validSettings) {
        try {
          const metaOpts = {
            ...opts,
            autoChoose: false,
            think: false,
            format: 'json'
          };
          const sysPrompt = 'You are a hyperparameter tuner for LLM inference. ' + 'Select the optimal sampling parameters for the task type described.\n\n' + 'PARAMETER GUIDE:\n' + '  - Code generation: temperature=0.1, top_p=0.8, top_k=20\n' + '  - JSON/structured output: temperature=0.0, top_p=1.0, top_k=1\n' + '  - Creative/generative writing: temperature=0.7-0.9, top_p=0.8-0.95, top_k=20-50\n' + '  - Reasoning/analysis: temperature=0.5-0.6, top_p=0.8, top_k=20\n' + '  - Factual Q&A/verification: temperature=0.0-0.2, top_p=0.8, top_k=10\n\n' + 'Output ONLY valid JSON: {"temperature":0.7,"top_p":0.9,"top_k":40}';
          const msgContext = JSON.stringify(messages);
          const metaR = await this.callChat([{
            role: 'system',
            content: sysPrompt
          }, {
            role: 'user',
            content: `Select optimal sampling parameters for this task:\n${msgContext}`
          }], false, null, metaOpts);
          const match = metaR.content.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('No JSON detected');
          const parsed = JSON.parse(match[0]);
          if ('temperature' in parsed && 'top_p' in parsed && 'top_k' in parsed) {
            const temp = Number(parsed.temperature),
              p = Number(parsed.top_p),
              k = Number(parsed.top_k);
            if (!isNaN(temp) && !isNaN(p) && !isNaN(k)) validSettings = {
              temperature: temp,
              top_p: p,
              top_k: k
            };
          }
        } catch {}
      }
      opts = {
        ...opts,
        autoChoose: false
      };
      opts.options = {
        ...(opts.options || {}),
        ...validSettings
      };
    }
    if (opts._globalBudget) {
      opts._globalBudget.llmCalls = (opts._globalBudget.llmCalls || 0) + 1;
      if (opts._globalBudget.llmCalls > (opts._globalBudget.maxLLMCalls || 300)) throw new Error('Global LLM call budget exhausted');
    }
    const maxAttempts = 3;
    const DELAYS = [500, 1000, 2000];
    let useStream = opts.forceStream !== false;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = (await this.getNextApiKey()) || process.env.OLLAMA_API_KEY || null;
      const client = this.buildClient(key);
      const samplingProfile = SAMPLING[opts.samplingProfile] || {};
      const mergedOptions = {
        ...qwen,
        ...samplingProfile,
        ...(opts.options || {})
      };
      try {
        const result = await this.limiter.run(() => client.chat({
          model: opts.model || this.model,
          messages: consolidateSystemMessages(messages),
          stream: useStream,
          options: mergedOptions,
          think: opts.think,
          format: opts.format,
          keep_alive: opts.keep_alive,
          max_tokens: opts.max_tokens,
          onChunk: stream && typeof onChunk === 'function' ? onChunk : null,
          ollamaOutput: opts.ollamaOutput
        }));
        this._markKeySuccess(key);
        return result;
      } catch (err) {
        lastErr = err;
        this._markKeyFailure(key);
        if (attempt === 0 && /stream|chunked/i.test(err.message) && useStream) {
          useStream = false;
          continue;
        }
        if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, DELAYS[attempt]));
      }
    }
    throw lastErr;
  }
  async detectComputeNeeds(input, opts = {}) {
    const r = await this.callChat([{
      role: 'system',
      content: 'You are a Compute Orchestrator. Your goal is to determine if a request requires precise computational verification via a sandbox to prevent hallucinations.\n\n' +
      'CLASSIFICATION PROTOCOL:\n' +
      '  - mode: "none" $\\rightarrow$ The request is conceptual, qualitative, or an open-ended reasoning task.\n' +
      '  - mode: "single" $\\rightarrow$ The request requires a single, definite numeric, symbolic, or algorithmic result (e.g., "What is 2^100?", "Calculate the 50th Fibonacci number").\n' +
      '  - mode: "parallel" $\\rightarrow$ The request requires multiple independent computations that can be run concurrently (e.g., "Calculate the first 5 primes and their sum").\n\n' +
      'SENSITIVITY GUIDE:\n' +
      '  - If the answer depends on a a precise mathematical property, an iterative loop, or a complex combination, use "single" or "parallel".\n' +
      '  - If the task is a "sanity check" on a number, use "single".\n\n' +
      'Output ONLY valid JSON — no markdown, no prose:\n' +
      '{"mode":"none" | "single" | "parallel", "task":"<the precise executable task>", "tasks":["<task1>", "<task2>"]}'
    }, {
      role: 'user',
      content: messagesToText(input)
    }], false, null, {
      ...opts,
      think: false,
      samplingProfile: 'json'
    });
    try {
      const p = JSON.parse(stripCodeFences(r.content || '{}'));
      if (!p.mode || p.mode === 'none') return {
        mode: 'none'
      };
      if (p.mode === 'parallel' && Array.isArray(p.tasks) && p.tasks.length >= 2) return {
        mode: 'parallel',
        tasks: p.tasks.slice(0, 4)
      };
      if (p.mode === 'single' && p.task) return {
        mode: 'single',
        task: p.task
      };
    } catch {}
    return {
      mode: 'none'
    };
  }
  async runChecks(input, response, checksCount, opts = {}, groundTruth = null, sandboxPrefix = []) {
    const inputText = messagesToText(input);
    const gtVal = groundTruth?.sandboxValidated ? String(groundTruth.value).trim() : null;
    const personas = [{
      label: 'Standard',
      system: gtVal ? `You are a Ground Truth Verifier. The sandbox-verified answer is [${gtVal}]. Your sole mission is to detect any deviation from this value. If the response contradicts this value or omits it where required, you MUST return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}` : 'You are a Quality Assurance Specialist. Audit the response for correctness, completeness, and adherence to the user\'s constraints. If any critical detail is missing or incorrect, you MUST return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
    }, {
      label: 'Adversarial',
      system: gtVal ? `You are a Red-Team Auditor. The verified answer is [${gtVal}]. Your goal is to dismantle the response. Look for "hallucinated precision" (adding detail that isn't true), logical leaps, or subtle deviations from the ground truth. If you find ANY flaw, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}` : 'You are a Red-Team Auditor. Assume the response contains a subtle error, a logical gap, or a hallucination. Be ruthless. Only return YES if the response is absolutely flawless. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
    }, {
      label: 'Numerical',
      model: this.auditModel,
      system: gtVal ? `You are a Numerical Forensic Analyst. Does the response explicitly and correctly state the verified value [${gtVal}]? Any rounding error, sign flip, or missing digit is a failure. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}` : 'You are a Numerical Forensic Analyst. Audit every number and calculation in the response. Check for internal consistency, order-of-magnitude errors, and precision loss. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
    }].slice(0, Math.min(checksCount, 3));
    const results = await Promise.allSettled(personas.map(p => this.callChat([...sandboxPrefix, {
      role: 'system',
      content: p.system
    }, {
      role: 'user',
      content: `<input>\n${inputText}\n</input>\n\n<response>\n${response}\n</response>\n\nVerdict:`
    }], false, null, {
      ...opts,
      think: false,
      model: p.model || this.auditModel,
      samplingProfile: 'verify'
    })));
    return results.map((r, i) => {
      const p = personas[i];
      if (r.status === 'rejected') return {
        correct: false,
        feedback: `Checker (${p.label}): ${r.reason?.message}`
      };
      const text = (r.value.content || '').trim();
      let verdict, reason;
      try {
        const j = JSON.parse(text);
        verdict = j.verdict;
        reason = j.reason;
      } catch {
        verdict = /^YES/i.test(text) ? 'YES' : 'NO';
        reason = text.replace(/^NO[:\s]*/i, '');
      }
      const ok = /^YES$/i.test(String(verdict || ''));
      return {
        correct: ok,
        feedback: ok ? null : reason || `Checker (${p.label}) flagged response.`
      };
    });
  }
  async consolidateBrainMemory(brain, opts = {}) {
    if (!(brain instanceof Brain) || !brain.isOverCapacity()) return;
    const evicted = brain.evict();
    if (!evicted.length) return;
    try {
      const r = await this.callChat([{
        role: 'system',
        content: 'Compress the following memory items into dense semantic facts.\n' + 'Rules:\n' + '  - Preserve all specific values, numbers, and key conclusions.\n' + '  - Remove redundancy and filler.\n' + '  - Output ONLY the compressed plain text, no JSON, no labels.'
      }, {
        role: 'user',
        content: JSON.stringify(evicted, null, 2)
      }], false, null, {
        ...opts,
        think: false,
        samplingProfile: 'reasoning'
      });
      brain.appendToSemantic((r.content || '').trim());
    } catch (err) {
      console.warn(`\x1b[33m[BRAIN] Consolidation failed: ${err.message}\x1b[0m`);
      for (const item of evicted)
        if ((item._failCount || 0) < 1) brain.workingMemory.push({
          ...item,
          _failCount: (item._failCount || 0) + 1
        });
    }
  }
  async generate(input, opts = {}) {
    const type = opts.type ?? 'string';
    const depth = opts.depth ?? 1;
    const checks = opts.checks ?? 0;
    const onChunk = opts.onChunk ?? null;
    const mergedOpts = {
      ...opts,
      type,
      depth
    };
    const brain = mergedOpts.humanBrain ? mergedOpts._brain instanceof Brain ? mergedOpts._brain : new Brain() : null;

    // Mixture-of-agents: multiple models, judge merges. additive new flow.
    if (Array.isArray(mergedOpts.mixtureModels) && mergedOpts.mixtureModels.length >= 2) {
      const bound = mergedOpts.mixtureModels.map(m => ({
        name: typeof m === 'string' ? m : m.name,
        callChat: (typeof m === 'string' ? this.callChat : (m.callChat || this.callChat.bind(this)))
      }));
      const judge = mergedOpts.mixtureJudge || this.callChat.bind(this);
      const r = await runMoA(bound, judge, input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    // Evolve-then-apply: run a synthetic-RL prompt evolution pass against the benchmark, then
    // apply the winning prompt template to the actual user input. The evolution log is written
    // to data/evolved/<runId>/ for inspection.
    if (mergedOpts.evolve) {
      const evoOpts = {
        ...mergedOpts,
        popSize: mergedOpts.evolvePop || 10,
        generations: mergedOpts.evolveGenerations || 6,
        runId: mergedOpts.evolveRunId || undefined
      };
      const evo = await evolvePrompts(this.callChat.bind(this), evoOpts);
      // if user only wanted to evolve (evolveOnly), return the summary
      if (mergedOpts.evolveOnly) return evo;
      // otherwise apply the best prompt to the real input
      const sys = evo.best.systemPrompt;
      const r = await applyEvolvedPrompt(this.callChat.bind(this), sys, input, mergedOpts);
      return parseDataType(r, type !== 'string' ? type : 'string');
    }

    // evolvedApply: user already has a run dir from a prior evolution; just apply its best prompt.
    if (mergedOpts.evolvedApply) {
      const best = loadBest(mergedOpts.evolvedApply);
      const r = await applyEvolvedPrompt(this.callChat.bind(this), best.systemPrompt, input, mergedOpts);
      return parseDataType(r, type !== 'string' ? type : 'string');
    }

    // Tool-use loop: model calls tools, we run them, loop until "finish". additive new flow.
    if (mergedOpts.tools === true || (mergedOpts.tools && typeof mergedOpts.tools === 'object')) {
      const toolOpts = { ...mergedOpts, tools: Array.isArray(mergedOpts.tools) ? mergedOpts.tools : DEFAULT_TOOLS };
      const r = await toolLoop(this.callChat.bind(this), input, toolOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    // Plan-and-execute: explicit plan, run steps, reflect, synthesize. additive new flow.
    if (mergedOpts.planExecute) {
      const r = await runPlanAndExecute(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    // Persona debate: two agents argue, judge picks. additive new flow.
    if (mergedOpts.debate) {
      const r = await runDebate(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    // Self-consistency: N samples, majority vote. additive new flow.
    if (mergedOpts.selfConsistency && (mergedOpts.selfConsistencySamples || 5) >= 2) {
      const r = await selfConsistency(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    // Reflexion: pull past lessons, run main flow, on failure learn a new lesson. additive.
    let reflexionCtx = null;
    if (mergedOpts.reflexion) {
      const r = attachReflexion(this.callChat.bind(this), input, mergedOpts);
      reflexionCtx = r;
    }

    // Confidence calibration: just tracks per-type wins/losses and exposes a getter.
    const calibrator = mergedOpts.calibrate ? makeCalibrator(mergedOpts._calibration || {}) : null;

    if (mergedOpts.analytical && !mergedOpts._skipAnalytical) {
      const ctx = {
        callChat: this.callChat.bind(this),
        generate: this.generate.bind(this),
        limiter: this.limiter
      };
      return analyzeAndSolve(ctx, input, type, depth, checks, onChunk, mergedOpts, 0);
    }

    if (mergedOpts.cognitiveFlow && !mergedOpts._skipCognitiveFlow) {
      const inputText = messagesToText(input);
      const flowResult = await runCognitiveFlow(this.callChat.bind(this), inputText, mergedOpts);
      
      const preFinal = [
          { role: 'system', content: `Extract the final verified answer from this cognitive process log. Match the requested data type: ${mergedOpts.type}. Output ONLY the final answer.` },
          { role: 'user', content: flowResult }
      ];
      
      const isStream = typeof mergedOpts.onChunk === 'function';
      const finalSamplingProfile = mergedOpts.samplingProfile || (type !== 'string' ? 'verify' : 'creative');
      
      if (isStream) mergedOpts.onChunk('\n\n=== [FINAL SYNTHESIS] ===\n\n', { kind: 'content' });
      
      let result = await this.callChat(preFinal, isStream, mergedOpts.onChunk, {
          ...mergedOpts,
          samplingProfile: finalSamplingProfile,
          think: mergedOpts.depth > 0
      });
      
      let rawText = stripThinkBlocks(result.content || '');
      return parseDataType(rawText, type !== 'string' ? type : 'string');
    }

    const baseMessages = this.normalizeMessages(input, mergedOpts);
    const inputText = messagesToText(input);
    if (brain) brain.add('input', inputText, 9);
    let finalMessages = baseMessages.map(cloneMessage);
    if (mergedOpts.images && Array.isArray(mergedOpts.images)) {
      let lastUserMsg = finalMessages.slice().reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        lastUserMsg.images = mergedOpts.images;
      } else {
        finalMessages.push({
          role: 'user',
          content: 'Attached image.',
          images: mergedOpts.images
        });
      }
    }
    let thinkCtxMsg = null;
    if (depth > 0) {
      const thinkResults = await runThink(this.callChat.bind(this), inputText, depth, mergedOpts);
      if (brain) brain.add('think_stages', Object.keys(thinkResults).join(', '), 6);
      let thinkCtx = 'BACKGROUND THINKING PROCESS (do not repeat this in your answer):\n';
      for (const [k, v] of Object.entries(thinkResults))
        if (v && typeof v === 'string') thinkCtx += `\n[${k.toUpperCase()}]\n${v}\n`;
      if (brain) {
        await this.consolidateBrainMemory(brain, mergedOpts);
        const bc = brain.getContextBlock();
        if (bc) thinkCtx = bc + '\n\n' + thinkCtx;
      }
      thinkCtxMsg = {
        role: 'system',
        content: thinkCtx
      };
      finalMessages = insertSystemPrompt(finalMessages, thinkCtx);
    }
    let codeExec = null;
    let sandboxPrefix = [];
    if (depth > 0 && mergedOpts.enableCode !== false) {
      const needs = await this.detectComputeNeeds(input, mergedOpts);
      const callCode = task => generateAndRunCode(this.callChat.bind(this), task, inputText, mergedOpts);
      // reflexion hint before the first model call, if enabled
      if (reflexionCtx) {
        const hint = await reflexionCtx.getHint();
        if (hint) mergedOpts.systemPrompt = (mergedOpts.systemPrompt || '') + '\n\n' + hint;
      }
      if (needs.mode === 'parallel') {
        try {
          const results = await Promise.all(needs.tasks.map(t => this.limiter.run(() => callCode(t))));
          const combined = results.map((r, i) => `Task ${i + 1}: ${needs.tasks[i]}\nResult: ${r.result}`).join('\n\n');
          codeExec = {
            result: results.map(r => r.result).join(' | '),
            sandboxValidated: true
          };
          sandboxPrefix = [{
            role: 'system',
            content: sandbox + `PARALLEL SANDBOX RESULTS${combined}\n\nDo NOT contradict these values.`
          }];
          finalMessages = [...(thinkCtxMsg ? [thinkCtxMsg] : []), {
            role: 'user',
            content: `Original: ${inputText}`
          }];
        } catch (e) {
          finalMessages = insertSystemPrompt(finalMessages, `PARALLEL CODE FAILED: ${e.message}. Use reasoning.`);
        }
      } else if (needs.mode === 'single' && needs.task) {
        try {
          codeExec = await callCode(needs.task);
          if (brain) brain.add('code_result', `${needs.task} = ${codeExec.result}`, 10);
          sandboxPrefix = [{
            role: 'system',
            content: sandbox + `SANDBOX RESULT\nTask:${needs.task}\nResult: ${codeExec.result}\n\nThis value is CERTAIN. Your answer MUST state [${codeExec.result}] exactly.`
          }];
          finalMessages = [...(thinkCtxMsg ? [thinkCtxMsg] : []), {
            role: 'user',
            content: `Original: ${inputText}`
          }];
        } catch (e) {
          finalMessages = insertSystemPrompt(finalMessages, `CODE FAILED: ${e.message}. Use reasoning.`);
        }
      }
    }
    const preFinal = consolidateSystemMessages(finalMessages);
    const isStream = typeof onChunk === 'function';
    const finalSamplingProfile = mergedOpts.samplingProfile || (type !== 'string' ? 'verify' : 'creative');
    let result = await this.callChat([...sandboxPrefix, ...preFinal], isStream, onChunk, {
      ...mergedOpts,
      samplingProfile: finalSamplingProfile
    });
    let rawText = stripThinkBlocks(result.content || '');
    if (codeExec?.sandboxValidated) {
      const gt = String(codeExec.result).trim();
      if (gt && !rawText.includes(gt)) rawText += `\n\n**Verified Answer: ${gt}**`;
    }
    if (brain) brain.add('first_response', rawText, 6);
    if (checks > 0) {
      const maxIter = mergedOpts.maxCheckIterations ?? 10;
      const gt = codeExec ? {
        value: codeExec.result,
        sandboxValidated: !!codeExec.sandboxValidated
      } : null;
      const monitor = new Metacognitive({
        windowSize: mergedOpts.monitorWindowSize ?? 5
      });
      monitor.updateBest(rawText, 0);
      let convo = [...preFinal.filter(m => m.role !== 'system'), {
        role: 'assistant',
        content: rawText
      }];
      for (let iter = 0; iter < maxIter; iter++) {
        const checkResults = await this.runChecks(input, rawText, checks, mergedOpts, gt, sandboxPrefix);
        const passed = checkResults.filter(r => r.correct).length;
        monitor.updateBest(rawText, passed);
        const failed = checkResults.filter(r => !r.correct);
        if (!failed.length) break;
        if (monitor.trackFeedback(failed)) {
          rawText = monitor.interrupt(rawText);
          break;
        }
        if (monitor.trackResponse(rawText)) {
          rawText = monitor.interrupt(rawText);
          break;
        }
        const gtReminder = gt?.sandboxValidated ? `GROUND TRUTH: The answer is [${gt.value}]. Do not recalculate.` : '';
        const feedback = `${failed.length}/${checks} checker(s) found issues:\n` + [...new Set(failed.map(f => f.feedback).filter(Boolean))].map((f, i) => `• ${i + 1}: ${f}`).join('\n') + gtReminder + '\n\nRevise your response to address all issues.';
        const lastIsFeedback = convo.at(-1)?.role === 'user' && convo.at(-1).content.includes('checker(s) found issues');
        convo = lastIsFeedback ? [...convo.slice(0, -1), {
          role: 'user',
          content: feedback
        }] : [...convo, {
          role: 'user',
          content: feedback
        }];
        const isLast = iter === maxIter - 1;
        result = await this.callChat([...sandboxPrefix, ...consolidateSystemMessages([...preFinal.filter(m => m.role === 'system'), ...convo])], isStream && isLast, isStream && isLast ? onChunk : null, {
          ...mergedOpts,
          samplingProfile: finalSamplingProfile
        });
        rawText = stripThinkBlocks(result.content || '');
        if (codeExec?.sandboxValidated) {
          const gtv = String(codeExec.result).trim();
          if (gtv && !rawText.includes(gtv)) rawText += `\n\n**Verified Answer: ${gtv}**`;
        }
        convo = [...convo, {
          role: 'assistant',
          content: rawText
        }];
      }
    }
    if (brain) brain.add('final_response', rawText, 9);

    // smart compression hook: if a long running convo was carried in, compress the messages
    if (Array.isArray(mergedOpts._compressMessages)) {
      mergedOpts._compressMessages = await compress(this.callChat.bind(this), mergedOpts._compressMessages, mergedOpts);
    } else if (Array.isArray(mergedOpts._truncatableMessages) && mergedOpts._truncatableMessages.length > 12) {
      mergedOpts._truncatableMessages = truncateMiddle(mergedOpts._truncatableMessages, 4, 8);
    }

    // confidence calibration record: if a ground truth was provided, mark this attempt
    if (calibrator) {
      const truth = mergedOpts._groundTruth;
      if (truth !== undefined) {
        const passed = String(parseDataType(rawText, type !== 'string' ? type : 'string')) === String(truth);
        calibrator.record(type, passed);
      }
    }

    // reflexion learn: if user marked the result as failed, write a lesson
    if (reflexionCtx && mergedOpts._lastResultFailed) {
      try { await reflexionCtx.learn(mergedOpts._lastResultFailed); } catch {}
    }

    let finalOutput = parseDataType(rawText, type !== 'string' ? type : 'string');
    if (mergedOpts.ollamaOutput) {
      finalOutput = result.thinking ? `<think>\n${result.thinking}\n</think>\n\n${rawText}` : rawText;
    }
    return finalOutput;
  }
}
Deepthink.BrainMemory = Brain;
Deepthink.MetacognitiveMonitor = Metacognitive;
Deepthink.AsyncMutex = Async;
Deepthink.compareResults = compareResults;
Deepthink.PYTHON_BIN = PYTHON_BIN;
Deepthink.SANDBOX_GT_SENTINEL = sandbox;
Deepthink.SAMPLING = SAMPLING;
Deepthink.QWEN_DEFAULTS = qwen;
export default Deepthink;