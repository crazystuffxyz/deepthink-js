// providers/index.ts
// @ts-nocheck — large pre-existing surface, runtime-tested, full type coverage deferred.
import { Ollama } from 'ollama';

type ChatMessage = { role: string; content: string; images?: string[] };
// token counts + latency are optional extras the ollama client reports;
// the trace layer reads them when present.
type ChatResult = { content: string; thinking: string; promptTokens?: number | null; responseTokens?: number | null; latencyMs?: number | null };
type StreamMeta = { kind: 'content' | 'thinking' };
type ChatParams = {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: Record<string, unknown>;
  think?: boolean | string;
  format?: string | object;
  keep_alive?: string;
  max_tokens?: number;
  onChunk?: ((chunk: string, meta: StreamMeta) => void) | null;
  ollamaOutput?: boolean;
};
type ProviderClient = { chat: (p: ChatParams) => Promise<ChatResult> };
type ProviderOpts = {
  provider?: string;
  host?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  anthropicVersion?: string;
  [k: string]: unknown;
};

const def = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234'
};

// cloud-tier calls can hang forever with no timeout — wrap fetch so every
// request (and its stream) dies after OLLAMA_TIMEOUT_MS (default 15 min).
// legit generations finish in minutes; a hang is never legitimate.
function makeTimeoutFetch(timeoutMs: number): typeof fetch {
  return ((input: any, init: any) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }) as typeof fetch;
}

// one client per host|key — the old code rebuilt new Ollama(...) on every
// retry attempt, which drops keep-alive/agent pooling each time
const _ollamaClientCache = new Map<string, ProviderClient>();
// every non-ollama adapter calls raw fetch — give it the same hang-guard the
// ollama wrapper has (HTTP_TIMEOUT_MS, 5 min default)
const httpFetch = makeTimeoutFetch(Number(process.env.HTTP_TIMEOUT_MS) || 300_000);

function buildOllamaClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const host = (opts.host || process.env.OLLAMA_HOST || def.ollama).replace(/\/api\/?$/, '').replace(/\/+$/, '') || undefined;
  const hdrs: Record<string, string> = { ...(opts.headers || {}) };
  if (apiKey) hdrs.Authorization = `Bearer ${apiKey}`;
  const ck = `${host}|${apiKey || ''}|${Object.keys(hdrs).join(',')}`;
  const hit = _ollamaClientCache.get(ck);
  if (hit) return hit;
  const cfg: Record<string, unknown> = {};
  if (host) cfg.host = host;
  if (Object.keys(hdrs).length) cfg.headers = hdrs;
  cfg.fetch = makeTimeoutFetch(Number(process.env.OLLAMA_TIMEOUT_MS) || 900_000);
  const ollamaClient = new Ollama(cfg as ConstructorParameters<typeof Ollama>[0]);
  const client: ProviderClient = {
    async chat(params) {
      const { model, messages, stream, options, think, format, keep_alive: keep, onChunk, ollamaOutput } = params;
      // ollama's API wants raw base64 in images[], not data URIs — strip the
      // prefix so vision models accept the payload
      const ollamaMessages = (messages || []).map(m => {
        if (Array.isArray(m.images) && m.images.length) {
          return { ...m, images: m.images.map(img => String(img).replace(/^data:[^;]+;base64,/, '')) };
        }
        return m;
      });
      const chatOpts: Record<string, unknown> = {
        model,
        messages: ollamaMessages,
        stream: stream ?? false,
        options: options || {},
        ...(think !== undefined && { think }),
        ...(format !== undefined && { format }),
        // default keep_alive holds the model resident between the probe /
        // check / revision rounds — cloud models ignore it, so only locals
        keep_alive: keep ?? (/-cloud$/i.test(String(model)) ? undefined : '30m')
      };
      _stripUndefined(chatOpts);
      if (stream && typeof onChunk === 'function') {
        const response = await ollamaClient.chat({ ...(chatOpts as Parameters<typeof ollamaClient.chat>[0]), stream: true });
        let text = '', thinking = '';
        let thinkingStarted = false, thinkingEnded = false;
        let promptTokens = null, responseTokens = null, latencyMs = null;
        for await (const part of response) {
          const th = part?.message?.thinking || '';
          const ct = part?.message?.content || '';
          if (part?.done) {
            if (part.prompt_eval_count != null) promptTokens = part.prompt_eval_count;
            if (part.eval_count != null) responseTokens = part.eval_count;
            if (part.total_duration != null) latencyMs = part.total_duration / 1e6;
          }
          if (ollamaOutput) {
            if (th && !thinkingStarted) { onChunk('<think>\n', { kind: 'content' }); thinkingStarted = true; }
            if (th) onChunk(th, { kind: 'content' });
            if (ct && thinkingStarted && !thinkingEnded) { onChunk('\n</think>\n\n', { kind: 'content' }); thinkingEnded = true; }
            if (ct) onChunk(ct, { kind: 'content' });
          } else {
            if (th) onChunk(th, { kind: 'thinking' });
            if (ct) onChunk(ct, { kind: 'content' });
          }
          if (th) thinking += th;
          if (ct) text += ct;
        }
        if (ollamaOutput && thinkingStarted && !thinkingEnded) onChunk('\n</think>\n\n', { kind: 'content' });
        return { content: _stripThink(text), thinking: _stripThink(thinking), promptTokens: promptTokens ?? null, responseTokens: responseTokens ?? null, latencyMs: latencyMs ?? null };
      } else {
        const r = await ollamaClient.chat({ ...(chatOpts as Parameters<typeof ollamaClient.chat>[0]), stream: false });
        const ct = r?.message?.content || '';
        const th = r?.message?.thinking || '';
        if (stream && typeof onChunk === 'function') {
          if (ollamaOutput) {
            if (th) onChunk(`<think>\n${th}\n</think>\n\n`, { kind: 'content' });
            if (ct) onChunk(ct, { kind: 'content' });
          } else {
            if (th) onChunk(th, { kind: 'thinking' });
            if (ct) onChunk(ct, { kind: 'content' });
          }
        }
        return { content: _stripThink(ct), thinking: _stripThink(th), promptTokens: r?.prompt_eval_count ?? null, responseTokens: r?.eval_count ?? null, latencyMs: r?.total_duration != null ? r.total_duration / 1e6 : null };
      }
    }
  };
  _ollamaClientCache.set(ck, client);
  return client;
}

function buildOpenAICompatClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const baseUrl = (opts.baseUrl || opts.host || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = apiKey || opts.apiKey || process.env.OPENAI_API_KEY || '';
  return {
    async chat(params) {
      const { model, messages, stream, options, max_tokens: max, onChunk } = params;
      const body: Record<string, unknown> = {
        model,
        messages: _convertMessagesToOpenAI(messages),
        stream: stream ?? false,
        temperature: options?.temperature,
        top_p: options?.top_p,
        ...(max != null && { max_tokens: max }),
        ...(options?.max_tokens != null && { max_tokens: options.max_tokens as number })
      };
      _stripUndefined(body);
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) };
      if (stream && typeof onChunk === 'function') {
        const response = await httpFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return _readOpenAIStream(response, onChunk);
      } else {
        const response = await httpFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
        if (!response.ok) { const txt = await response.text(); throw new Error(`${response.status} ${response.statusText}: ${txt}`); }
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        return { content: _stripThink(content), thinking: '' };
      }
    }
  };
}

function buildCustomClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const baseUrl = (opts.baseUrl || opts.host || 'http://localhost:8080/v1').replace(/\/+$/, '');
  const key = apiKey || opts.apiKey || 'unused';
  return {
    async chat(params) {
      const { model, messages, stream, options, max_tokens: max, think, onChunk } = params;
      const body: Record<string, unknown> = {
        model,
        messages: _convertMessagesToOpenAI(messages),
        stream: stream ?? false,
        temperature: options?.temperature,
        top_p: options?.top_p,
        ...(max != null && { max_tokens: max }),
        ...(options?.max_tokens != null && { max_tokens: options.max_tokens as number }),
        thinking: think ? (options?.thinkingLevel || 'low') : 'off',
        grounding: options?.grounding === true
      };
      _stripUndefined(body);
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) };
      if (stream && typeof onChunk === 'function') {
        const response = await httpFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return _readCustomStream(response, onChunk);
      } else {
        const response = await httpFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
        if (!response.ok) { const txt = await response.text(); throw new Error(`${response.status} ${response.statusText}: ${txt}`); }
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const thinking = data.choices?.[0]?.message?.thinking || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || '';
        return { content: _stripThink(content), thinking: _stripThink(thinking) };
      }
    }
  };
}

function buildClaudeClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const baseUrl = (opts.baseUrl || opts.host || 'https://api.anthropic.com').replace(/\/+$/, '');
  const key = apiKey || opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const version = opts.anthropicVersion || '2023-06-01';
  return {
    async chat(params) {
      const { model, messages, stream, options, max_tokens: max, think, onChunk } = params;
      const systemMsgs = messages.filter(m => m.role === 'system');
      const conversationMsgs = messages.filter(m => m.role !== 'system');
      const systemText = systemMsgs.map(m => m.content).join('\n\n').trim();
      const body: Record<string, unknown> = {
        model,
        messages: _convertMessagesToClaude(conversationMsgs),
        max_tokens: max ?? (options?.max_tokens as number) ?? 8192,
        stream: stream ?? false,
        temperature: options?.temperature,
        top_p: options?.top_p,
        ...(systemText && { system: systemText }),
        ...(think && { thinking: { type: 'enabled', budget_tokens: 8000 } })
      };
      _stripUndefined(body);
      const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': version, ...(opts.headers || {}) };
      if (stream && typeof onChunk === 'function') {
        const response = await httpFetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return _readClaudeStream(response, onChunk);
      } else {
        const response = await httpFetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
        if (!response.ok) { const txt = await response.text(); throw new Error(`${response.status} ${response.statusText}: ${txt}`); }
        const data = await response.json();
        const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
        const thinkBlock = data.content?.find((b: { type: string }) => b.type === 'thinking');
        return { content: _stripThink(textBlock?.text || ''), thinking: _stripThink(thinkBlock?.thinking || '') };
      }
    }
  };
}

function buildGeminiClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const key = apiKey || opts.apiKey || process.env.GEMINI_API_KEY || '';
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
  return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}

function buildGeminiWebClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const cookie = apiKey || opts.apiKey || process.env.GEMINI_WEB_COOKIE || '';
  let geminiInstance: { ask: (text: string) => Promise<string> } | null = null;
  return {
    async chat(params) {
      const { messages, stream, onChunk } = params;
      if (!geminiInstance) {
        try {
          const BardModule = await import('bard-ai') as { default: new (cookie: string) => { ask: (text: string) => Promise<string> } };
          const Bard = BardModule.default || BardModule;
          geminiInstance = new Bard(cookie) as unknown as { ask: (text: string) => Promise<string> };
        } catch {
          throw new Error('bard-ai not found. Please install it using: npm install bard-ai');
        }
      }
      let promptText = '';
      for (const m of messages) {
        if (m.role === 'system') promptText += `[SYSTEM INSTRUCTIONS]\n${m.content}\n\n`;
        else promptText += `[${m.role.toUpperCase()}]\n${m.content}\n\n`;
      }
      const responseText = await geminiInstance.ask(promptText.trim());
      if (stream && typeof onChunk === 'function') onChunk(responseText, { kind: 'content' });
      return { content: _stripThink(responseText), thinking: '' };
    }
  };
}

function buildPerplexityClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const key = apiKey || opts.apiKey || process.env.PERPLEXITY_API_KEY || '';
  const baseUrl = opts.baseUrl || 'https://api.perplexity.ai';
  return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}

function buildGrokClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const key = apiKey || opts.apiKey || process.env.XAI_API_KEY || '';
  const baseUrl = opts.baseUrl || 'https://api.x.ai/v1';
  return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}

function buildLMStudioClient(opts: ProviderOpts, apiKey: string | null): ProviderClient {
  const baseUrl = (opts.baseUrl || opts.host || def.lmstudio + '/v1').replace(/\/+$/, '');
  const key = apiKey || opts.apiKey || 'lm-studio';
  return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}

function buildProviderClient(opts: ProviderOpts = {}, apiKey: string | null = null): ProviderClient {
  const provider = (opts.provider || 'ollama').toLowerCase();
  switch (provider) {
    case 'openai':
      return buildOpenAICompatClient({ ...opts, baseUrl: opts.baseUrl || opts.host || 'https://api.openai.com/v1' }, apiKey || opts.apiKey || process.env.OPENAI_API_KEY);
    case 'claude':
    case 'anthropic':
      return buildClaudeClient(opts, apiKey || opts.apiKey || process.env.ANTHROPIC_API_KEY);
    case 'gemini':
    case 'google':
      return buildGeminiClient(opts, apiKey || opts.apiKey || process.env.GEMINI_API_KEY);
    case 'gemini-web':
      return buildGeminiWebClient(opts, apiKey || opts.apiKey || process.env.GEMINI_WEB_COOKIE);
    case 'perplexity':
      return buildPerplexityClient(opts, apiKey || opts.apiKey || process.env.PERPLEXITY_API_KEY);
    case 'grok':
    case 'xai':
      return buildGrokClient(opts, apiKey || opts.apiKey || process.env.XAI_API_KEY);
    case 'lmstudio':
      return buildLMStudioClient(opts, apiKey);
    case 'openai-compat':
      return buildOpenAICompatClient(opts, apiKey || opts.apiKey);
    case 'custom':
      return buildCustomClient(opts, apiKey);
    case 'ollama':
    default:
      return buildOllamaClient(opts, apiKey);
  }
}

function _stripThink(text: string): string {
  return String(text ?? '').replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
}

function _stripUndefined(obj: Record<string, unknown>): void {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
}

function _convertMessagesToOpenAI(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (Array.isArray(m.images) && m.images.length > 0) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content || '' },
          ...m.images.map(img => ({ type: 'image_url', image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` } }))
        ]
      };
    }
    return { role: m.role, content: m.content };
  });
}

function _convertMessagesToClaude(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(m => {
    if (Array.isArray(m.images) && m.images.length > 0) {
      return {
        role: m.role,
        content: [
          ...m.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.replace(/^data:[^;]+;base64,/, '') } })),
          { type: 'text', text: m.content || '' }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function _readOpenAIStream(response: Response, onChunk: (chunk: string, meta: StreamMeta) => void): Promise<ChatResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) { text += delta; onChunk(delta, { kind: 'content' }); }
      } catch { /* malformed chunk */ }
    }
  }
  return { content: _stripThink(text), thinking: '' };
}

async function _readCustomStream(response: Response, onChunk: (chunk: string, meta: StreamMeta) => void): Promise<ChatResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let thinking = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const deltaObj = json.choices?.[0]?.delta || {};
        const th = deltaObj.thinking || deltaObj.reasoning_content || deltaObj.reasoning || '';
        if (th) { thinking += th; onChunk(th, { kind: 'thinking' }); }
        const ct = deltaObj.content || '';
        if (ct) { text += ct; onChunk(ct, { kind: 'content' }); }
      } catch { /* malformed chunk */ }
    }
  }
  return { content: _stripThink(text), thinking: _stripThink(thinking) };
}

async function _readClaudeStream(response: Response, onChunk: (chunk: string, meta: StreamMeta) => void): Promise<ChatResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let thinking = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        if (json.type === 'content_block_delta') {
          const delta = json.delta;
          if (delta?.type === 'text_delta' && delta.text) { text += delta.text; onChunk(delta.text, { kind: 'content' }); }
          else if (delta?.type === 'thinking_delta' && delta.thinking) { thinking += delta.thinking; onChunk(delta.thinking, { kind: 'thinking' }); }
        }
      } catch { /* malformed chunk */ }
    }
  }
  return { content: _stripThink(text), thinking: _stripThink(thinking) };
}

export { buildProviderClient, buildCustomClient, buildOllamaClient, buildOpenAICompatClient, buildClaudeClient, buildGeminiClient, buildGeminiWebClient, buildPerplexityClient, buildGrokClient, buildLMStudioClient };
export type { ProviderClient, ChatParams, ChatMessage, ChatResult, ProviderOpts };
