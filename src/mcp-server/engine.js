// src/mcp-server/engine.js
// thin wrapper over deepthink's own engine so the MCP tools don't each
// construct their own Deepthink. one pooled instance per model (shared with
// the proxy), plus the research/humanize/vision surfaces they need.
import { Ollama } from 'ollama';
import {
  Deepthink,
  runDeepResearch,
  humanizeText,
  loadImages,
  describeImages,
  looksVisionCapable,
} from '../../dist/index.js';

const DEFAULT_MODEL = process.env.DEEPTHINK_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b-cloud';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

const pool = new Map(); // model -> Deepthink

function dt(model) {
  const m = model || DEFAULT_MODEL;
  if (!pool.has(m)) pool.set(m, new Deepthink(m, [], { provider: 'ollama', host: OLLAMA_HOST }));
  return pool.get(m);
}

// keep the old src/mcp.js API so the proxy keeps working unchanged
function getEngine(model) {
  return dt(model);
}

function destroy() {
  for (const d of pool.values()) d.destroy();
  pool.clear();
}

// pull well-formed json out of whatever the model wrote around it. models
// love wrapping answers in fences or prose.
function extractJSON(raw) {
  let s = String(raw)
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {}
  const m = s.match(/[\[{][\s\S]*[\]]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  throw new Error('could not extract JSON from model output');
}

// native tool-calling chat. deepthink's ProviderClient doesn't pass `tools`
// through, so the auto-agent loop uses the ollama client directly — same
// host deepthink already talks to. non-streaming keeps tool_calls clean.
function rawClient() {
  return new Ollama({ host: OLLAMA_HOST });
}

export function makeEngine() {
  return {
    defaultModel: DEFAULT_MODEL,
    host: OLLAMA_HOST,
    dt,
    looksVisionCapable,

    async generate(prompt, opts = {}) {
      return dt(opts.model).generate(prompt, {
        type: opts.type || 'string',
        depth: opts.depth ?? 1,
        checks: opts.checks ?? 0,
        mcts: !!opts.mcts,
      });
    },

    async generateJSON(prompt, opts = {}) {
      const raw = await dt(opts.model).generate(prompt, {
        type: 'json',
        depth: opts.depth ?? 1,
        checks: opts.checks ?? 0,
        mcts: !!opts.mcts,
      });
      return extractJSON(typeof raw === 'string' ? raw : JSON.stringify(raw));
    },

    // research + humanize both want a bare (messages, stream, onChunk, opts)
    // chat fn — bind callChat for the pooled instance.
    async deepResearch(topic, opts = {}) {
      const d = dt(opts.model);
      return runDeepResearch(d.callChat.bind(d), topic, opts);
    },

    async humanize(text, opts = {}) {
      const d = dt(opts.model);
      return humanizeText(d.callChat.bind(d), text, opts);
    },

    // image sources: path / url / data-uri / base64 strings
    async describe(sources, opts = {}) {
      const loaded = await loadImages(sources);
      const d = dt(opts.model);
      return describeImages(d.callChat.bind(d), loaded, opts);
    },

    // single vision round-trip (used by the svg loop and image analysis)
    async chatVision({ model, base64, prompt, images = [] }) {
      const d = dt(model);
      const r = await d.callChat(
        [{ role: 'user', content: prompt, images: [base64, ...images] }],
        false,
        null,
        { think: false, autoSystemPrompt: false }
      );
      return { ok: true, content: r.content || '' };
    },

    async chatTools({ model, messages, system, tools, options = {} }) {
      const msgs = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ];
      const r = await rawClient().chat({
        model: model || DEFAULT_MODEL,
        messages: msgs,
        tools,
        stream: false,
        options,
      });
      return { content: r.message?.content || '', tool_calls: r.message?.tool_calls || [] };
    },

    async streamChat({ model, messages, system, onToken }) {
      const msgs = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ];
      let text = '';
      await rawClient().chat({
        model: model || DEFAULT_MODEL,
        messages: msgs,
        stream: true,
        onMessage: (m) => {
          if (m?.message?.content) {
            text += m.message.content;
            if (onToken) onToken(m.message.content);
          }
        },
      });
      return text;
    },

    async listModels() {
      const r = await rawClient().list();
      return { ok: true, models: (r.models || []).map((m) => ({ name: m.name, size: m.size })) };
    },

    async health() {
      try {
        const r = await rawClient().list();
        return { ok: true, models: (r.models || []).map((m) => m.name) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export { DEFAULT_MODEL, destroy, destroy as destroyEngines, getEngine };
