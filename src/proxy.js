// src/proxy.js — OpenAI + Anthropic compatible HTTP proxy over deepthink-js
// npm run proxy → http://127.0.0.1:8000/v1 (OpenAI) + /v1/messages (Anthropic) + /mcp (MCP)
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { TraceStore } from '../dist/index.js';
import { attachMcpRoutes, destroyEngines, getEngine } from './mcp.js';

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_INFLIGHT = Number(process.env.DEEPTHINK_MAX_INFLIGHT || 8);
const API_KEY = process.env.DEEPTHINK_API_KEY || null; // optional bearer auth
const HEARTBEAT_MS = 15000; // SSE keep-alive while the engine thinks

const app = Fastify({ logger: false });
let inflight = 0;

// optional bearer auth + origin guard for the localhost server
app.addHook('onRequest', (req, reply, done) => {
  if (API_KEY) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${API_KEY}`) {
      reply.code(401).send({ error: { message: 'invalid api key', type: 'authentication_error', param: null, code: null } });
      return;
    }
  }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    reply.code(403).send({ error: { message: 'origin not allowed', type: 'permission_error', param: null, code: null } });
    return;
  }
  done();
});

// ---------- helpers ----------

// pull text out of OpenAI/Anthropic content blocks
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image_url' ? '[image]' : ''))
      .join('\n');
  }
  return String(content ?? '');
}

// multi-turn messages -> one prompt string, role-tagged
function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const role = m.role;
    if (role === 'system') continue;
    const text = textOf(m.content);
    if (role === 'tool') {
      parts.push(`<tool>\n${text}\n</tool>`);
      continue;
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls
        .map((tc) => `tool_call: ${tc.function?.name}(${tc.function?.arguments})`)
        .join('\n');
      parts.push(`<${role}>\n${text}\n${calls}\n</${role}>`);
      continue;
    }
    parts.push(`<${role}>\n${text}\n</${role}>`);
  }
  return parts.join('\n\n');
}

function systemOf(messages) {
  return messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
}

function clampNum(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) n = Number(fallback);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// deepthink knobs: body.deepthink object or x-deepthink-* headers
function deepthinkOpts(body, headers) {
  const cfg = (body && typeof body === 'object' && body.deepthink) || {};
  const h = (n) => headers[n.toLowerCase()];
  const depth = clampNum(cfg.depth, h('x-deepthink-depth'), 1, 0, 3);
  const checks = clampNum(cfg.checks, h('x-deepthink-checks'), depth > 0 ? 1 : 0, 0, 5);
  const type = typeof cfg.type === 'string' && cfg.type ? cfg.type : 'string';
  const enableCode = cfg.enableCode !== false;
  const model = typeof cfg.model === 'string' && cfg.model ? cfg.model : h('x-deepthink-model') || undefined;
  return { depth, checks, type, enableCode, model };
}

function usageOf(trace) {
  let p = 0;
  let c = 0;
  for (const e of trace.toJSON()) {
    if (e.promptTokens) p += e.promptTokens;
    if (e.responseTokens) c += e.responseTokens;
  }
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function traceSummary(trace) {
  const evs = trace.toJSON();
  const calls = evs.length;
  const ms = evs.reduce((a, e) => a + (e.latencyMs || 0), 0);
  const phases = {};
  for (const e of evs) phases[e.phase] = (phases[e.phase] || 0) + 1;
  return `deepthink: ${calls} calls, ${ms}ms, phases ${JSON.stringify(phases)}`;
}

function err(reply, code, message, type) {
  return reply.code(code).send({ error: { message, type, param: null, code: null } });
}

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// keep the stream alive while the engine thinks (proxies kill silent SSE)
function startHeartbeat(res) {
  const hb = setInterval(() => {
    if (res.destroyed) {
      clearInterval(hb);
      return;
    }
    res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  res.on('close', () => clearInterval(hb));
  return hb;
}

// strip the pipeline's internal synthesis marker from streamed text
const MARKER = /\n*=== \[FINAL SYNTHESIS\] ===\n*/g;

// ---------- OpenAI ----------

app.get('/v1/models', async () => {
  const model = getEngine().model;
  return {
    object: 'list',
    data: [{ id: model, object: 'model', created: 0, owned_by: 'deepthink' }],
  };
});

app.post('/v1/chat/completions', async (req, reply) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return err(reply, 400, 'messages is required', 'invalid_request_error');
  if (inflight >= MAX_INFLIGHT) return err(reply, 429, 'too many concurrent deepthink calls', 'rate_limit_error');

  const opts = deepthinkOpts(body, req.headers);
  const stream = body.stream === true;
  const wantTrace = req.headers['x-deepthink-trace'] === 'true';
  const prompt = messagesToPrompt(messages);
  const system = systemOf(messages);
  const trace = new TraceStore('flat', 500);
  const t0 = Date.now();
  const engine = getEngine(opts.model);
  const model = engine.model;
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const genOpts = { ...opts, systemPrompt: system, _trace: trace };

  inflight++;
  try {
    if (stream) {
      reply.hijack();
      reply.raw.writeHead(200, sseHeaders);
      startHeartbeat(reply.raw);
      sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      if (wantTrace) {
        sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: traceSummary(trace) }, finish_reason: null }] });
      }
      await engine.generate(prompt, {
        ...genOpts,
        onChunk: (chunk, meta) => {
          if (meta.kind !== 'content' || reply.raw.destroyed) return;
          const text = chunk.replace(MARKER, '');
          if (!text) return;
          sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        },
      });
      sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (body.stream_options && body.stream_options.include_usage) {
        sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(trace) });
      }
      reply.raw.end('data: [DONE]\n\n');
      return reply;
    }

    const answer = await engine.generate(prompt, genOpts);
    const text = typeof answer === 'object' && answer !== null ? JSON.stringify(answer) : String(answer);
    const payload = {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: usageOf(trace),
    };
    if (wantTrace) {
      payload.choices[0].message.reasoning_content = traceSummary(trace);
      payload._deepthink = { trace: trace.toJSON(), calls: trace.size, ms: Date.now() - t0 };
    }
    reply.header('x-deepthink-trace-id', id);
    reply.header('x-deepthink-calls', String(trace.size));
    reply.header('x-deepthink-ms', String(Date.now() - t0));
    return payload;
  } catch (e) {
    if (stream) {
      // stream already hijacked — end it so the client sees a clean stop
      try {
        sseWrite(reply.raw, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        reply.raw.end('data: [DONE]\n\n');
      } catch {}
      return reply;
    }
    return err(reply, 500, e.message, 'server_error');
  } finally {
    inflight--;
  }
});

// ---------- Anthropic ----------

app.post('/v1/messages', async (req, reply) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return err(reply, 400, 'messages is required', 'invalid_request_error');
  if (inflight >= MAX_INFLIGHT) return err(reply, 429, 'too many concurrent deepthink calls', 'rate_limit_error');

  const opts = deepthinkOpts(body, req.headers);
  const stream = body.stream === true;
  const wantTrace = req.headers['x-deepthink-trace'] === 'true';
  const prompt = messagesToPrompt(messages);
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((s) => s.text ?? '').join('\n') : '';
  const trace = new TraceStore('flat', 500);
  const t0 = Date.now();
  const engine = getEngine(opts.model);
  const model = engine.model;
  const id = `msg_${randomUUID()}`;
  const genOpts = { ...opts, systemPrompt: system, _trace: trace };
  // body.max_tokens is required by the real API but we don't cap the engine

  inflight++;
  try {
    if (stream) {
      reply.hijack();
      reply.raw.writeHead(200, sseHeaders);
      startHeartbeat(reply.raw);
      const ev = (obj) => reply.raw.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
      ev({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      if (wantTrace) {
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: traceSummary(trace) } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } });
        ev({ type: 'content_block_stop', index: 0 });
      }
      ev({ type: 'content_block_start', index: wantTrace ? 1 : 0, content_block: { type: 'text', text: '' } });
      await engine.generate(prompt, {
        ...genOpts,
        onChunk: (chunk, meta) => {
          if (meta.kind !== 'content' || reply.raw.destroyed) return;
          const text = chunk.replace(MARKER, '');
          if (!text) return;
          ev({ type: 'content_block_delta', index: wantTrace ? 1 : 0, delta: { type: 'text_delta', text } });
        },
      });
      ev({ type: 'content_block_stop', index: wantTrace ? 1 : 0 });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usageOf(trace).completion_tokens } });
      ev({ type: 'message_stop' });
      reply.raw.end();
      return reply;
    }

    const answer = await engine.generate(prompt, genOpts);
    const text = typeof answer === 'object' && answer !== null ? JSON.stringify(answer) : String(answer);
    const usage = usageOf(trace);
    const content = [];
    if (wantTrace) content.push({ type: 'thinking', thinking: traceSummary(trace) });
    content.push({ type: 'text', text });
    const payload = {
      id,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    };
    if (wantTrace) payload._deepthink = { trace: trace.toJSON(), calls: trace.size, ms: Date.now() - t0 };
    reply.header('x-deepthink-trace-id', id);
    reply.header('x-deepthink-calls', String(trace.size));
    reply.header('x-deepthink-ms', String(Date.now() - t0));
    return payload;
  } catch (e) {
    if (stream) {
      try {
        reply.raw.end();
      } catch {}
      return reply;
    }
    return reply.code(500).send({ type: 'error', error: { type: 'api_error', message: e.message }, request_id: id });
  } finally {
    inflight--;
  }
});

// ---------- MCP + health ----------

attachMcpRoutes(app);

app.get('/health', async () => ({ ok: true, model: getEngine().model, inflight }));

// ---------- boot ----------

export function startProxy(port = PORT, host = HOST) {
  return app.listen({ port, host }).then(() => {
    console.log(`deepthink proxy on http://${host}:${port}`);
    console.log(`  OpenAI:    POST /v1/chat/completions  GET /v1/models`);
    console.log(`  Anthropic: POST /v1/messages`);
    console.log(`  MCP:       /mcp (streamable HTTP)`);
    console.log(`  model:     ${getEngine().model}`);
    return app;
  });
}

export function stopProxy() {
  return app.close().then(() => destroyEngines());
}

// CLI: node src/proxy.js
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  startProxy().catch((e) => {
    console.error('proxy failed to start:', e);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await stopProxy();
      process.exit(0);
    });
  }
}
