// src/effortProxy.js — universal effort-aware proxy over ollama
//
// Listens on :11436 by default and speaks every major wire format:
//   - ollama native     POST /api/chat, /api/generate (+ every other route passthrough)
//   - OpenAI / xAI      POST /v1/chat/completions, GET /v1/models
//   - Anthropic/Claude  POST /v1/messages
//   - Gemini            POST /v1beta/models/{model}:generateContent[|streamGenerateContent]
//
// Behavior: every request proxies straight through to $OLLAMA_HOST (default
// http://localhost:11434) byte-for-byte. When the payload carries a thinking
// effort — body.reasoning_effort, body.reasoning.effort, body.think
// ("low"|"medium"|"high"), body.thinking.budget_tokens (Anthropic),
// generationConfig.thinkingConfig.thinkingBudget (Gemini), or an explicit
// body.deepthink.effort / x-deepthink-effort header — the request instead
// runs through the deepthink-js engine with depth/checks mapped from the
// effort tier, re-framed into whichever wire format the caller used.
//
// Capture mode: set DEEPTHINK_CAPTURE=1 (or a file path) to append every
// inbound request body to a log — for discovering where a client parks its
// effort parameter.
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { TraceStore } from '../dist/index.js';
import { getEngine, destroyEngines } from './mcp.js';

const PORT = Number(process.env.DEEPTHINK_PROXY_PORT || process.env.PORT || 11436);
const HOST = process.env.HOST || '127.0.0.1';
const HP = Number(process.env.HTTP_TIMEOUT_MS || 600_000);
const OLLAMA_HOST = normalizeHost(process.env.OLLAMA_HOST || 'http://localhost:11434');
const MAX_INFLIGHT = Number(process.env.DEEPTHINK_MAX_INFLIGHT || 8);
const HEARTBEAT_MS = 15000;
const SSE = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
const MARKER = /\n*=== \[FINAL SYNTHESIS\] ===\n*/g;
const NDJSON = (o) => JSON.stringify(o) + '\n';

function normalizeHost(h) {
  let s = String(h || '').trim() || 'http://localhost:11434';
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

// hung upstream fetch must die, not hold a slot forever
const timeoutFetch = (ms) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
};

let capStream = null;
if (process.env.DEEPTHINK_CAPTURE) {
  const p = process.env.DEEPTHINK_CAPTURE === '1' ? '.proxy-capture.log' : process.env.DEEPTHINK_CAPTURE;
  capStream = fs.createWriteStream(p, { flags: 'a' });
  console.error(`[effortProxy] capturing request bodies to ${p}`);
}
// always-on ring (last 50) so GET /_capture can show where effort lives
// even without DEEPTHINK_CAPTURE
const CAP_RING_MAX = 50;
const capRing = [];
function capture(req, body) {
  const entry = { ts: new Date().toISOString(), method: req.method, url: req.url, body };
  const seen = [];
  const deep = body?.deepthink?.effort; if (typeof deep === 'string') seen.push(['deepthink.effort', deep]);
  const hh = req.headers?.['x-deepthink-effort']; if (typeof hh === 'string') seen.push(['x-deepthink-effort', hh]);
  if (typeof body?.reasoning_effort === 'string') seen.push(['reasoning_effort', body.reasoning_effort]);
  if (typeof body?.reasoning?.effort === 'string') seen.push(['reasoning.effort', body.reasoning.effort]);
  if (typeof body?.think === 'string') seen.push(['think', body.think]);
  if (body?.thinking?.budget_tokens) seen.push(['thinking.budget_tokens', body.thinking.budget_tokens]);
  if (typeof body?.output_config?.effort === 'string') seen.push(['output_config.effort', body.output_config.effort]);
  if (typeof body?.effort === 'string') seen.push(['effort', body.effort]);
  const g = body?.generationConfig || body?.generation_config || {};
  const tb = g?.thinkingConfig?.thinkingBudget; if (tb) seen.push(['thinkingConfig.thinkingBudget', tb]);
  entry.effortFields = seen;
  entry.effort = extractEffort(body, req.headers);
  capRing.push(entry);
  if (capRing.length > CAP_RING_MAX) capRing.shift();
  if (capStream) capStream.write(JSON.stringify({ ...entry, headers: req.headers }) + '\n');
}

const app = Fastify({ logger: false });
let inflight = 0;

app.addHook('onRequest', (req, reply, done) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    reply.code(403).send({ error: 'origin not allowed' });
    return;
  }
  done();
});
// non-JSON bodies (pull/push, anything binary) arrive as raw buffers so the
// passthrough can forward them untouched
app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

// ---------- effort parsing ----------

const TIERS = {
  off: { depth: 0, checks: 0, mcts: false },
  minimal: { depth: 0, checks: 0, mcts: false },
  low: { depth: 1, checks: 0, mcts: false },
  medium: { depth: 2, checks: 1, mcts: true },
  high: { depth: 2, checks: 2, mcts: true },
  xhigh: { depth: 3, checks: 2, mcts: true },
  ultracode: { depth: 3, checks: 2, mcts: true },
  max: { depth: 3, checks: 3, mcts: true },
};

function budgetToTier(b) {
  if (!(b > 0)) return null;
  if (b < 4096) return 'low';
  if (b < 12288) return 'medium';
  if (b < 24576) return 'high';
  if (b < 49152) return 'xhigh';
  return 'max';
}

// scan every place a client might park an effort parameter
function extractEffort(body, headers) {
  if (!body || typeof body !== 'object') return null;
  const deep = body.deepthink?.effort;
  if (typeof deep === 'string') return deep.toLowerCase();
  const h = headers?.['x-deepthink-effort'];
  if (typeof h === 'string') return h.toLowerCase();
  if (typeof body.reasoning_effort === 'string') return body.reasoning_effort.toLowerCase(); // OpenAI / xAI
  const re = body.reasoning?.effort;
  if (typeof re === 'string') return re.toLowerCase(); // Responses API (codex)
  if (typeof body.think === 'string') return body.think.toLowerCase(); // ollama think levels
  if (body.thinking && typeof body.thinking === 'object'
    && (body.thinking.type === 'enabled' || body.thinking.budget_tokens)) {
    // Anthropic budget → deepthink tier; max (≥48k) is its own seat
    return budgetToTier(Number(body.thinking.budget_tokens || 0)) || 'medium';
  }
  if (typeof body.output_config?.effort === 'string') return body.output_config.effort.toLowerCase(); // newer OpenAI-style
  if (typeof body.effort === 'string') return body.effort.toLowerCase(); // generic
  const g = body.generationConfig || body.generation_config || {};
  const tb = g.thinkingConfig?.thinkingBudget ?? g.thinking_config?.thinking_budget ?? body.thinkingConfig?.thinkingBudget;
  if (Number(tb) > 0) return budgetToTier(Number(tb)) || 'medium'; // Gemini
  return null;
}

// ---------- request normalization ----------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.text) || '').join('\n');
  return String(content ?? '');
}

function normalizeRequest(body) {
  if (Array.isArray(body.messages)) { // ollama chat, openai, anthropic
    const system = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : '');
    const parts = body.messages.map((m) => {
      const role = m.role === 'tool' ? 'tool' : m.role;
      return `<${role === 'assistant' ? 'assistant' : role}>\n${textOf(m.content)}\n</${role === 'assistant' ? 'assistant' : role}>`;
    });
    return { prompt: parts.join('\n\n'), system, model: body.model, stream: body.stream === true };
  }
  if (body.input !== undefined) { // OpenAI Responses API (codex)
    const toTxt = (c) => typeof c === 'string' ? c
      : (Array.isArray(c) ? c.map((p) => p?.text ?? p?.content ?? '').join('\n') : String(c?.text ?? ''));
    const items = Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input }];
    const parts = items.map((m) => {
      const role = m?.role === 'assistant' ? 'assistant' : (m?.role || 'user');
      return `<${role}>\n${toTxt(m?.content)}\n</${role}>`;
    });
    return { prompt: parts.join('\n\n'), system: body.instructions || '', model: body.model, stream: body.stream === true };
  }
  if (Array.isArray(body.contents)) { // gemini
    const sys = body.systemInstruction?.parts?.map((p) => p.text).join('\n')
      || body.system_instruction?.parts?.map((p) => p.text).join('\n') || '';
    const prompt = body.contents.map((c) => {
      const role = c.role === 'model' ? 'assistant' : (c.role || 'user');
      return `<${role}>\n${(c.parts || []).map((p) => p.text || '').join('')}\n</${role}>`;
    }).join('\n\n');
    return { prompt, system: sys, model: String(body.model || '').replace(/^models\//, '').replace(/:.*$/, ''), stream: false };
  }
  if (typeof body.prompt === 'string') { // ollama generate
    return { prompt: body.prompt, system: body.system || '', model: body.model, stream: body.stream === true };
  }
  return null;
}

function usageOf(trace) {
  let p = 0, c = 0;
  for (const e of trace.toJSON()) { if (e.promptTokens) p += e.promptTokens; if (e.responseTokens) c += e.responseTokens; }
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}
const usageOf2 = (u) => u;

// ---------- passthrough ----------

async function passthrough(req, reply) {
  let body;
  if (Buffer.isBuffer(req.body)) body = req.body;
  else if (req.body !== undefined && req.body !== null) body = JSON.stringify(req.body);
  const headers = { ...req.headers };
  delete headers.host; delete headers.connection; delete headers['content-length']; delete headers['accept-encoding'];
  const t = timeoutFetch(HP);
  let upstream;
  try {
    upstream = await fetch(OLLAMA_HOST + req.url, { method: req.method, headers, body, signal: t.signal, duplex: 'half' });
  } catch (e) {
    t.done();
    return reply.code(502).send({ error: `upstream ${OLLAMA_HOST} failed: ${e.message}` });
  }
  t.done();
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k)) out[k] = v;
  });
  reply.hijack();
  reply.raw.writeHead(upstream.status, out);
  if (upstream.body) {
    for await (const chunk of upstream.body) { if (reply.raw.destroyed) break; reply.raw.write(chunk); }
  }
  if (!reply.raw.writableEnded) reply.raw.end();
  return reply;
}

// ---------- engine reply ----------

function startHeartbeat(raw) {
  const hb = setInterval(() => {
    if (raw.destroyed) { clearInterval(hb); return; }
    raw.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  raw.on('close', () => clearInterval(hb));
}

// model-agnostic: every request names its model; when one doesn't, fall to
// DEEPTHINK_MODEL → OLLAMA_MODEL → the library's own proven default
// (gemma4:31b-cloud) when the daemon has it, else the daemon's first
// non-cloud model, else whatever it lists.
const firstModel = { name: null };
(async () => {
  try {
    const r = await fetch(OLLAMA_HOST + '/api/tags');
    const j = await r.json();
    const names = (j?.models || []).map((m) => m.name).filter(Boolean);
    firstModel.name = names.find((n) => /^gemma4:31b-cloud$/i.test(n)) || null;
  } catch { /* daemon may come up later; default stays missing */ }
})();

function defaultModel() {
  return process.env.DEEPTHINK_MODEL || process.env.OLLAMA_MODEL || firstModel.name
    || 'gemma4:31b-cloud';
}

async function engineReply(req, reply, framing, body, effort) {
  const norm = normalizeRequest(body);
  if (!norm) return passthrough(req, reply);
  const tier = TIERS[effort] || TIERS.medium;
  const chosen = norm.model || defaultModel();
  if (!chosen) {
    return reply.code(502).send({ error: { message: 'no model in payload and no default (set DEEPTHINK_MODEL/OLLAMA_MODEL or start the ollama daemon)' } });
  }
  const engine = getEngine(chosen);
  const model = engine.model;
  const trace = new TraceStore('flat', 500);
  const genOpts = {
    depth: tier.depth, checks: tier.checks, mcts: tier.mcts,
    systemPrompt: norm.system || undefined,
    _trace: trace,
  };
  // ollama stream formats are NDJSON (bare JSON lines, no SSE comments);
  // /v1/messages and /v1/chat/completions stream SSE; gemini streams only
  // via ?alt=sse (the default streamGenerateContent returns a JSON array)
  const ndjsonFraming = framing === 'chat' || framing === 'generate';
  const wantStream = framing === 'gemini'
    ? String(req.url).includes('streamGenerateContent')
    : norm.stream;
  const t0 = Date.now();
  if (wantStream && framing !== 'gemini') {
    reply.hijack();
    reply.raw.writeHead(200, ndjsonFraming
      ? { 'Content-Type': 'application/x-ndjson', 'x-deepthink-effort': String(effort) }
      : { ...SSE, 'x-deepthink-effort': String(effort) });
    // SSE clients need keep-alives to survive long silent generation; NDJSON
    // lines ARE the heartbeat and a stray ": keep-alive" comment would be an
    // illegal JSON line for strict clients
    if (!ndjsonFraming) startHeartbeat(reply.raw);
  }
  try {
    if (framing === 'anthropic') {
      const id = `msg_${randomUUID()}`;
      const emit = (obj) => { if (!reply.raw.destroyed) reply.raw.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); };
      if (!wantStream) {
        const r = await engine.generate(norm.prompt, { ...genOpts });
        const u = usageOf(trace);
        return reply.send({
          id, type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: String(r).replace(MARKER, '') }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
        });
      }
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      emit({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      let idx = -1, opened = false, inThinking = false;
      const openBlock = (type) => { idx++; opened = true; inThinking = type === 'thinking'; emit({ type: 'content_block_start', index: idx, content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } }); };
      const closeBlock = () => { if (opened) { opened = false; emit({ type: 'content_block_stop', index: idx }); } };
      await engine.generate(norm.prompt, {
        ...genOpts,
        onChunk: (chunk, meta) => {
          const text = String(chunk || '').replace(MARKER, '');
          if (!text) return;
          usage.completion_tokens += 1;
          if (meta.kind === 'thinking') {
            if (!opened || !inThinking) { closeBlock(); openBlock('thinking'); }
            emit({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: text } });
          } else {
            if (opened && !inThinking) { /* same text block, keep streaming */ }
            else { closeBlock(); openBlock('text'); }
            emit({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
          }
        },
      });
      closeBlock();
      const u = usageOf(trace);
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: u.completion_tokens } });
      emit({ type: 'message_stop' });
      reply.raw.end(); // without this the client's body read never completes
      return reply;
    }
    if (framing === 'openai') {
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      if (wantStream) {
        const chunk = (delta, finish = null) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`); };
        chunk({ role: 'assistant', content: '' });
        await engine.generate(norm.prompt, { ...genOpts, onChunk: (c2, meta) => {
          const text = String(c2 || '').replace(MARKER, '');
          if (!text || reply.raw.destroyed) return;
          if (meta.kind === 'thinking') chunk({ reasoning_content: text });
          else chunk({ content: text });
        } });
        chunk({}, 'stop');
        reply.raw.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(trace) })}\n\ndata: [DONE]\n\n`);
        return reply;
      }
      const r = await engine.generate(norm.prompt, genOpts);
      return reply.send({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: String(r).replace(MARKER, '') }, finish_reason: 'stop' }],
        usage: usageOf(trace),
      });
    }
    if (framing === 'responses') {
      const rid = `resp_${randomUUID()}`;
      if (wantStream) {
        let seq = 0;
        const emit = (obj) => { if (!reply.raw.destroyed) reply.raw.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); };
        const base = { id: rid, object: 'response', created_at: Math.floor(t0 / 1000), model, usage: null };
        emit({ type: 'response.created', sequence_number: seq++, response: { ...base, status: 'in_progress', output: [] } });
        emit({ type: 'response.in_progress', sequence_number: seq++, response: { ...base, status: 'in_progress', output: [] } });
        let reasoningAdded = false, messageAdded = false, reasoningTxt = '', text = '';
        const rItem = () => ({ type: 'reasoning', id: `rs_${rid.slice(5)}`, summary: [] });
        const mItem = () => ({ type: 'message', id: `msg_${rid.slice(5)}`, status: 'in_progress', role: 'assistant', content: [] });
        await engine.generate(norm.prompt, { ...genOpts, onChunk: (c2, meta) => {
          const text2 = String(c2 || '').replace(MARKER, '');
          if (!text2 || reply.raw.destroyed) return;
          if (meta.kind === 'thinking') {
            if (!reasoningAdded) { reasoningAdded = true; emit({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: rItem() }); }
            reasoningTxt += text2;
            emit({ type: 'response.reasoning_summary_text.delta', sequence_number: seq++, item_id: `rs_${rid.slice(5)}`, output_index: 0, delta: text2 });
          } else {
            if (!messageAdded) { messageAdded = true; emit({ type: 'response.output_item.added', sequence_number: seq++, output_index: 1, item: mItem() }); }
            text += text2;
            emit({ type: 'response.output_text.delta', sequence_number: seq++, item_id: `msg_${rid.slice(5)}`, output_index: 1, content_index: 0, delta: text2 });
          }
        } });
        const u = usageOf(trace);
        const output = [];
        if (reasoningAdded) output.push({ type: 'reasoning', id: `rs_${rid.slice(5)}`, summary: [{ type: 'summary_text', text: reasoningTxt }] });
        if (messageAdded) output.push({ type: 'message', id: `msg_${rid.slice(5)}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
        emit({ type: 'response.completed', sequence_number: seq++,
          response: { id: rid, object: 'response', created_at: Math.floor(t0 / 1000), status: 'completed', model, output,
            usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens } } });
        reply.raw.end();
        return reply;
      }
      const r = await engine.generate(norm.prompt, genOpts);
      const u = usageOf(trace);
      return reply.send({
        id: rid, object: 'response', created_at: Math.floor(t0 / 1000), status: 'completed', model,
        instructions: norm.system || null,
        output: [{ type: 'message', id: `msg_${rid.slice(5)}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: String(r).replace(MARKER, ''), annotations: [] }] }],
        usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens },
      });
    }
    if (framing === 'completions') { // legacy OpenAI text completions
      const r = await engine.generate(norm.prompt, genOpts);
      const u = usageOf(trace);
      return reply.send({
        id: `cmpl-${randomUUID()}`, object: 'text_completion', created: Math.floor(t0 / 1000), model,
        choices: [{ text: String(r).replace(MARKER, ''), index: 0, finish_reason: 'stop' }],
        usage: usageOf2(u),
      });
    }
    if (framing === 'gemini') {
      const r = await engine.generate(norm.prompt, genOpts);
      const candidate = { candidates: [{ content: { parts: [{ text: String(r).replace(MARKER, '') }], role: 'model' }, finishReason: 'STOP' }] };
      if (String(req.url).includes('streamGenerateContent')) {
        if (String(req.url).includes('alt=sse')) {
          reply.hijack();
          reply.raw.writeHead(200, SSE);
          reply.raw.end(`data: ${JSON.stringify(candidate)}\n\n`);
        } else {
          // default streamGenerateContent is a JSON array — emit the whole
          // result as a one-element array (engine completes before flushing)
          reply.hijack();
          reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify([candidate]));
        }
        return reply;
      }
      return reply.send(candidate);
    }
    // ollama native: chat NDJSON / generate JSON
    if (framing === 'generate') {
      if (wantStream) {
        const out = { response: '', thinking: '' };
        await engine.generate(norm.prompt, { ...genOpts, onChunk: (c2, meta) => {
          const text = String(c2 || '').replace(MARKER, '');
          if (!text || reply.raw.destroyed) return;
          if (meta.kind === 'thinking') { out.thinking += text; reply.raw.write(NDJSON({ model, thinking: text })); }
          else { out.response += text; reply.raw.write(NDJSON({ model, response: text })); }
        } });
        const u = usageOf(trace);
        reply.raw.end(NDJSON({
          model,
          response: out.response,
          ...(out.thinking ? { thinking: out.thinking } : {}),
          done: true, done_reason: 'stop',
          total_duration: Date.now() - t0,
          prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens,
        }));
        return reply;
      }
      const r = await engine.generate(norm.prompt, genOpts);
      const u = usageOf(trace);
      return reply.send({ model, response: String(r).replace(MARKER, ''), done: true, done_reason: 'stop', total_duration: Date.now() - t0, prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens });
    }
    if (wantStream) {
      const content = { text: '', thinking: '' };
      await engine.generate(norm.prompt, { ...genOpts, onChunk: (c2, meta) => {
        const text = String(c2 || '').replace(MARKER, '');
        if (!text || reply.raw.destroyed) return;
        if (meta.kind === 'thinking') { content.thinking += text; reply.raw.write(NDJSON({ model, message: { role: 'assistant', thinking: text } })); }
        else { content.text += text; reply.raw.write(NDJSON({ model, message: { role: 'assistant', content: text } })); }
      } });
      const u = usageOf(trace);
      reply.raw.end(NDJSON({
        model,
        message: { role: 'assistant', content: content.text, ...(content.thinking ? { thinking: content.thinking } : {}) },
        done: true, done_reason: 'stop',
        total_duration: Date.now() - t0,
        prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens,
      }));
      return reply;
    }
    const r = await engine.generate(norm.prompt, genOpts);
    const content = String(r).replace(MARKER, '');
    return reply.send({ model, message: { role: 'assistant', content }, done: true, done_reason: 'stop' });
  } catch (e) {
    if (!reply.raw.headersSent) return reply.code(500).send({ error: { message: e.message } });
    if (!reply.raw.writableEnded) reply.raw.end();
    return reply;
  } finally {
    // heartbeat self-cleans when the connection goes away
  }
}

// ---------- routes ----------

app.get('/health', async () => ({ ok: true, inflight, upstream: OLLAMA_HOST, capture: !!capStream }));

// the four effort-checking gates; body already parsed by fastify for JSON
async function gate(req, reply, framing) {
  const body = req.body;
  if (req.method !== 'POST' || body === undefined || Buffer.isBuffer(body)) return passthrough(req, reply);
  capture(req, body); // ring + optional disk capture: see where effort hides
  const effort = extractEffort(body, req.headers);
  if (!effort) return passthrough(req, reply);
  reply.header('x-deepthink-effort', String(effort));
  if (inflight >= MAX_INFLIGHT) { reply.code(429).send({ error: 'too many concurrent deepthink calls' }); return reply; }
  inflight++;
  try {
    return await engineReply(req, reply, framing, body, effort);
  } finally {
    inflight--;
  }
}

app.post('/api/chat', async (req, reply) => gate(req, reply, 'chat'));
app.post('/api/generate', async (req, reply) => gate(req, reply, 'generate'));
app.post('/v1/chat/completions', async (req, reply) => gate(req, reply, 'openai'));
app.post('/v1/messages', async (req, reply) => gate(req, reply, 'anthropic'));
app.post('/v1/responses', async (req, reply) => gate(req, reply, 'responses'));
app.post('/v1/completions', async (req, reply) => gate(req, reply, 'completions'));
app.post('/v1beta/models/:model/:action', async (req, reply) => {
  if (!String(req.params.action || '').includes('generate')) return passthrough(req, reply);
  return gate(req, reply, 'gemini');
});
app.get('/v1/models', async () => {
  const list = await fetch(OLLAMA_HOST + '/api/tags').catch(() => null);
  const tags = list ? await list.json().catch(() => ({ models: [] })) : { models: [] };
  return { object: 'list', data: (tags.models || []).map((m) => ({ id: m.name, object: 'model', created: 0, owned_by: 'ollama' })) };
});

// full ollama path parity — every documented daemon route forwards verbatim
// (effort-gated methods are registered above; these are pure passthrough)
for (const r of [
  '/api/version', '/api/tags', '/api/ps', '/api/show', '/api/pull', '/api/push',
  '/api/copy', '/api/delete', '/api/create', '/api/embed', '/api/embeddings',
  '/api/me', '/api/web_search', '/api/web_fetch', '/api/openai/*', '/api/openai',
  '/api/experimental/*', '/api/blobs/*',
]) {
  app.all(r, async (req, reply) => passthrough(req, reply));
}

// capture inspector: shows exactly where each client parks its effort
app.get('/_capture', async () => ({
  count: capRing.length,
  note: 'ring holds the last 50 request bodies; effortFields lists where the effort parameter was found and what it parsed to',
  entries: capRing,
}));

// everything else rides untouched to the daemon
app.all('/*', async (req, reply) => passthrough(req, reply));

// tests import { app } with DEEPTHINK_PROXY_NO_LISTEN=1
export { app };
if (process.env.DEEPTHINK_PROXY_NO_LISTEN !== '1') {
  app.listen({ port: PORT, host: HOST }, () => {
    console.error(`[effortProxy] http://${HOST}:${PORT} → ${OLLAMA_HOST} (deepthink engine when payload carries effort)`);
  });
}

async function shutdown() {
  try { await app.close(); } catch { /* already down */ }
  destroyEngines();
  capStream?.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);