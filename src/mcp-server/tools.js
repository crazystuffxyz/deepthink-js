// src/mcp-server/tools.js
// central tool registry. every leaf module exports a default object of
// (args, ctx) => value fns; this file spreads them all into one map and
// adds the engine-wired + utility tools that live here directly.
// zod schemas live in schemas.js — this file only maps name -> fn.
import memoryTools from './memory.js';
import workerTools from './worker.js';
import codeintelTools from './codeintel.js';
import documentTools from './documents.js';
import runnerTools from './runner.js';
import visionTools from './vision.js';
import skillTools from './skills.js';
import agentTools from './agent.js';
import commanderTools from './commander.js';
import { MCTS, beamSearch } from './mcts.js';

// deepthink-native llm + research + humanize, all wired onto ctx.engine
const engineTools = {
  // plain multi-stage reasoning. type drives the output shape.
  deepthink_reason: async (args, ctx) => {
    const type = args.type || 'string';
    const depth = args.depth !== undefined ? Number(args.depth) : 1;
    const model = args.model;
    // enableCode is a no-op here — no sandboxed code path in reason
    if (type === 'json') {
      return ctx.engine.generateJSON(args.prompt, { model, depth, checks: 0, mcts: false });
    }
    return ctx.engine.generate(args.prompt, { model, type, depth, checks: 0, mcts: false });
  },

  deepthink_generate: async (args, ctx) => {
    return ctx.engine.generate(args.prompt, {
      model: args.model,
      type: args.type || 'string',
      depth: args.depth !== undefined ? Number(args.depth) : 1,
      checks: args.checks !== undefined ? Number(args.checks) : 1,
      mcts: args.mcts !== undefined ? Boolean(args.mcts) : true,
    });
  },

  deepthink_json: async (args, ctx) => {
    return ctx.engine.generateJSON(args.prompt, {
      model: args.model,
      depth: args.depth !== undefined ? Number(args.depth) : 1,
      checks: args.checks !== undefined ? Number(args.checks) : 1,
      mcts: args.mcts !== undefined ? Boolean(args.mcts) : true,
    });
  },

  deep_research: async (args, ctx) => {
    const result = await ctx.engine.deepResearch(args.topic, {
      model: args.model,
      maxQueries: args.maxQueries,
      maxConcurrency: args.maxConcurrency,
      credibilityThreshold: args.credibilityThreshold,
      maxSummaries: args.maxSummaries,
      useOllamaSearch: args.useOllamaSearch,
      academicFilter: args.academicFilter,
      enableCritique: args.enableCritique,
      files: args.files,
      mode: args.mode,
    });
    if (!result) return { ok: false, error: 'research returned no result' };
    return result;
  },

  ollama_chat: async (args, ctx) => {
    const res = await ctx.engine.streamChat({
      model: args.model,
      messages: args.messages,
      system: args.system,
    });
    return { ok: true, content: res };
  },

  // engine reads OLLAMA_API_KEY / OLLAMA_HOST from env at boot; this just
  // records the key on ctx.config for tools that want it. no live rewire.
  deepthink_set_api_key: async (args, ctx) => {
    const k = (args.apiKey || args.key || '').trim();
    if (k) ctx.config.apiKey = k;
    else delete ctx.config.apiKey;
    return { ok: true, hasKey: !!k, note: 'engine uses OLLAMA_API_KEY / OLLAMA_HOST env vars' };
  },

  // no detector module in deepthink — return a neutral placeholder score
  deepthink_check_score: async (args, ctx) => {
    return { ok: true, score: 0.5, note: 'detector not available; score is a placeholder' };
  },

  deepthink_humanize_text: async (args, ctx) => {
    return ctx.engine.humanize(args.text, { model: args.model, intensity: args.intensity });
  },

  list_models: async (args, ctx) => {
    const res = await ctx.engine.listModels();
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, models: res.models.map((m) => ({ name: m.name, size: m.size })) };
  },

  ollama_health: async (args, ctx) => {
    return ctx.engine.health();
  },
};

// mcts + beam search over candidate tool calls
const mctsTools = {
  deepthink_mcts_search: async (args, ctx) => {
    const m = new MCTS(ctx.engine, {
      iterations: args.iterations || 12,
      exploration: args.exploration || 1.414,
      cheap: !!args.cheap,
    });
    return m.search({
      state: { model: args.model },
      goal: args.goal,
      candidates: args.candidates || [],
    });
  },

  deepthink_beam_search: async (args, ctx) => {
    return beamSearch({
      engine: ctx.engine,
      candidates: args.candidates || [],
      state: { model: args.model },
      goal: args.goal,
      k: args.k || 3,
    });
  },
};

// simple stateless utilities, ported from the old server
const utilTools = {
  get_current_time: async () => new Date().toLocaleString('en-US', { timeZoneName: 'short' }),

  roll_dice: async (args) => {
    const s = Number(args.sides);
    if (!s || s < 2) return { ok: false, error: 'sides must be a number >= 2' };
    return { ok: true, sides: s, result: Math.floor(Math.random() * s) + 1 };
  },

  coin_flip: async () => ({ ok: true, result: Math.random() < 0.5 ? 'heads' : 'tails' }),

  echo_message: async (args) => ({ ok: true, echo: args.message }),

  random_number: async (args) => {
    const min = Number(args.min);
    const max = Number(args.max);
    if (Number.isNaN(min) || Number.isNaN(max) || min > max) {
      return { ok: false, error: 'invalid min/max range' };
    }
    return { ok: true, min, max, result: Math.floor(Math.random() * (max - min + 1)) + min };
  },

  // tail the shared ring buffer. filter by channel + since-ms, cap by last.
  get_event_log: async (args, ctx) => {
    let ev = ctx.eventLog;
    if (args.channel) ev = ev.filter((e) => e.channel === args.channel);
    if (args.since) ev = ev.filter((e) => e.ts >= Number(args.since));
    if (args.last) ev = ev.slice(-Number(args.last));
    return { ok: true, events: ev };
  },
};

// spread order matters: runner's deepthink_js_execute overrides worker's
// (both sandbox via ctx.pool, runner's is the fuller wrapper).
export const tools = {
  ...memoryTools,
  ...workerTools,
  ...codeintelTools,
  ...documentTools,
  ...runnerTools,
  ...visionTools,
  ...skillTools,
  ...agentTools,
  ...commanderTools,
  ...mctsTools,
  ...engineTools,
  ...utilTools,
};

// wire dispatch onto a shared ctx so cross-tool calls (rollback, agent
// tool nodes) can route through ctx.run
export function installDispatch(ctx) {
  ctx.run = async (name, args) => {
    const t = tools[name];
    if (!t) return { ok: false, error: 'unknown tool: ' + name };
    return t(args, ctx);
  };
}

export const TOOL_NAMES = Object.keys(tools).sort();
