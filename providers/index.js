// providers/index.ts
// @ts-nocheck — large pre-existing surface, runtime-tested, full type coverage deferred.
import { Ollama } from 'ollama';
const def = {
    ollama: 'http://localhost:11434',
    lmstudio: 'http://localhost:1234'
};
function buildOllamaClient(opts, apiKey) {
    const host = (opts.host || process.env.OLLAMA_HOST || def.ollama).replace(/\/api\/?$/, '').replace(/\/+$/, '') || undefined;
    const hdrs = { ...(opts.headers || {}) };
    if (apiKey)
        hdrs.Authorization = `Bearer ${apiKey}`;
    const cfg = {};
    if (host)
        cfg.host = host;
    if (Object.keys(hdrs).length)
        cfg.headers = hdrs;
    const ollamaClient = new Ollama(cfg);
    return {
        async chat(params) {
            const { model, messages, stream, options, think, format, keep_alive: keep, onChunk, ollamaOutput } = params;
            const chatOpts = {
                model,
                messages,
                stream: stream ?? false,
                options: options || {},
                ...(think !== undefined && { think }),
                ...(format !== undefined && { format }),
                ...(keep !== undefined && { keep_alive: keep })
            };
            if (stream && typeof onChunk === 'function') {
                const response = await ollamaClient.chat({ ...chatOpts, stream: true });
                let text = '', thinking = '';
                let thinkingStarted = false, thinkingEnded = false;
                for await (const part of response) {
                    const th = part?.message?.thinking || '';
                    const ct = part?.message?.content || '';
                    if (ollamaOutput) {
                        if (th && !thinkingStarted) {
                            onChunk('<think>\n', { kind: 'content' });
                            thinkingStarted = true;
                        }
                        if (th)
                            onChunk(th, { kind: 'content' });
                        if (ct && thinkingStarted && !thinkingEnded) {
                            onChunk('\n</think>\n\n', { kind: 'content' });
                            thinkingEnded = true;
                        }
                        if (ct)
                            onChunk(ct, { kind: 'content' });
                    }
                    else {
                        if (th)
                            onChunk(th, { kind: 'thinking' });
                        if (ct)
                            onChunk(ct, { kind: 'content' });
                    }
                    if (th)
                        thinking += th;
                    if (ct)
                        text += ct;
                }
                if (ollamaOutput && thinkingStarted && !thinkingEnded)
                    onChunk('\n</think>\n\n', { kind: 'content' });
                return { content: _stripThink(text), thinking: _stripThink(thinking) };
            }
            else {
                const r = await ollamaClient.chat({ ...chatOpts, stream: false });
                const ct = r?.message?.content || '';
                const th = r?.message?.thinking || '';
                if (stream && typeof onChunk === 'function') {
                    if (ollamaOutput) {
                        if (th)
                            onChunk(`<think>\n${th}\n</think>\n\n`, { kind: 'content' });
                        if (ct)
                            onChunk(ct, { kind: 'content' });
                    }
                    else {
                        if (th)
                            onChunk(th, { kind: 'thinking' });
                        if (ct)
                            onChunk(ct, { kind: 'content' });
                    }
                }
                return { content: _stripThink(ct), thinking: _stripThink(th) };
            }
        }
    };
}
function buildOpenAICompatClient(opts, apiKey) {
    const baseUrl = (opts.baseUrl || opts.host || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const key = apiKey || opts.apiKey || process.env.OPENAI_API_KEY || '';
    return {
        async chat(params) {
            const { model, messages, stream, options, max_tokens: max, onChunk } = params;
            const body = {
                model,
                messages: _convertMessagesToOpenAI(messages),
                stream: stream ?? false,
                temperature: options?.temperature,
                top_p: options?.top_p,
                ...(max != null && { max_tokens: max }),
                ...(options?.max_tokens != null && { max_tokens: options.max_tokens })
            };
            _stripUndefined(body);
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) };
            if (stream && typeof onChunk === 'function') {
                const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
                if (!response.ok)
                    throw new Error(`${response.status} ${response.statusText}`);
                return _readOpenAIStream(response, onChunk);
            }
            else {
                const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
                if (!response.ok) {
                    const txt = await response.text();
                    throw new Error(`${response.status} ${response.statusText}: ${txt}`);
                }
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '';
                return { content: _stripThink(content), thinking: '' };
            }
        }
    };
}
function buildCustomClient(opts, apiKey) {
    const baseUrl = (opts.baseUrl || opts.host || 'http://localhost:8080/v1').replace(/\/+$/, '');
    const key = apiKey || opts.apiKey || 'unused';
    return {
        async chat(params) {
            const { model, messages, stream, options, max_tokens: max, think, onChunk } = params;
            const body = {
                model,
                messages: _convertMessagesToOpenAI(messages),
                stream: stream ?? false,
                temperature: options?.temperature,
                top_p: options?.top_p,
                ...(max != null && { max_tokens: max }),
                ...(options?.max_tokens != null && { max_tokens: options.max_tokens }),
                thinking: think ? (options?.thinkingLevel || 'low') : 'off',
                grounding: options?.grounding === true
            };
            _stripUndefined(body);
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) };
            if (stream && typeof onChunk === 'function') {
                const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
                if (!response.ok)
                    throw new Error(`${response.status} ${response.statusText}`);
                return _readCustomStream(response, onChunk);
            }
            else {
                const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
                if (!response.ok) {
                    const txt = await response.text();
                    throw new Error(`${response.status} ${response.statusText}: ${txt}`);
                }
                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '';
                const thinking = data.choices?.[0]?.message?.thinking || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || '';
                return { content: _stripThink(content), thinking: _stripThink(thinking) };
            }
        }
    };
}
function buildClaudeClient(opts, apiKey) {
    const baseUrl = (opts.baseUrl || opts.host || 'https://api.anthropic.com').replace(/\/+$/, '');
    const key = apiKey || opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const version = opts.anthropicVersion || '2023-06-01';
    return {
        async chat(params) {
            const { model, messages, stream, options, max_tokens: max, think, onChunk } = params;
            const systemMsgs = messages.filter(m => m.role === 'system');
            const conversationMsgs = messages.filter(m => m.role !== 'system');
            const systemText = systemMsgs.map(m => m.content).join('\n\n').trim();
            const body = {
                model,
                messages: _convertMessagesToClaude(conversationMsgs),
                max_tokens: max ?? options?.max_tokens ?? 8192,
                stream: stream ?? false,
                temperature: options?.temperature,
                top_p: options?.top_p,
                ...(systemText && { system: systemText }),
                ...(think && { thinking: { type: 'enabled', budget_tokens: 8000 } })
            };
            _stripUndefined(body);
            const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': version, ...(opts.headers || {}) };
            if (stream && typeof onChunk === 'function') {
                const response = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
                if (!response.ok)
                    throw new Error(`${response.status} ${response.statusText}`);
                return _readClaudeStream(response, onChunk);
            }
            else {
                const response = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: false }) });
                if (!response.ok) {
                    const txt = await response.text();
                    throw new Error(`${response.status} ${response.statusText}: ${txt}`);
                }
                const data = await response.json();
                const textBlock = data.content?.find((b) => b.type === 'text');
                const thinkBlock = data.content?.find((b) => b.type === 'thinking');
                return { content: _stripThink(textBlock?.text || ''), thinking: _stripThink(thinkBlock?.thinking || '') };
            }
        }
    };
}
function buildGeminiClient(opts, apiKey) {
    const key = apiKey || opts.apiKey || process.env.GEMINI_API_KEY || '';
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
    return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}
function buildGeminiWebClient(opts, apiKey) {
    const cookie = apiKey || opts.apiKey || process.env.GEMINI_WEB_COOKIE || '';
    let geminiInstance = null;
    return {
        async chat(params) {
            const { messages, stream, onChunk } = params;
            if (!geminiInstance) {
                try {
                    const BardModule = await import('bard-ai');
                    const Bard = BardModule.default || BardModule;
                    geminiInstance = new Bard(cookie);
                }
                catch {
                    throw new Error('bard-ai not found. Please install it using: npm install bard-ai');
                }
            }
            let promptText = '';
            for (const m of messages) {
                if (m.role === 'system')
                    promptText += `[SYSTEM INSTRUCTIONS]\n${m.content}\n\n`;
                else
                    promptText += `[${m.role.toUpperCase()}]\n${m.content}\n\n`;
            }
            const responseText = await geminiInstance.ask(promptText.trim());
            if (stream && typeof onChunk === 'function')
                onChunk(responseText, { kind: 'content' });
            return { content: _stripThink(responseText), thinking: '' };
        }
    };
}
function buildPerplexityClient(opts, apiKey) {
    const key = apiKey || opts.apiKey || process.env.PERPLEXITY_API_KEY || '';
    const baseUrl = opts.baseUrl || 'https://api.perplexity.ai';
    return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}
function buildGrokClient(opts, apiKey) {
    const key = apiKey || opts.apiKey || process.env.XAI_API_KEY || '';
    const baseUrl = opts.baseUrl || 'https://api.x.ai/v1';
    return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}
function buildLMStudioClient(opts, apiKey) {
    const baseUrl = (opts.baseUrl || opts.host || def.lmstudio + '/v1').replace(/\/+$/, '');
    const key = apiKey || opts.apiKey || 'lm-studio';
    return buildOpenAICompatClient({ ...opts, baseUrl, apiKey: key }, key);
}
function buildProviderClient(opts = {}, apiKey = null) {
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
function _stripThink(text) {
    return String(text ?? '').replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
}
function _stripUndefined(obj) {
    for (const k of Object.keys(obj)) {
        if (obj[k] === undefined)
            delete obj[k];
    }
}
function _convertMessagesToOpenAI(messages) {
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
function _convertMessagesToClaude(messages) {
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
async function _readOpenAIStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]')
                continue;
            if (!trimmed.startsWith('data: '))
                continue;
            try {
                const json = JSON.parse(trimmed.slice(6));
                const delta = json.choices?.[0]?.delta?.content || '';
                if (delta) {
                    text += delta;
                    onChunk(delta, { kind: 'content' });
                }
            }
            catch { /* malformed chunk */ }
        }
    }
    return { content: _stripThink(text), thinking: '' };
}
async function _readCustomStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let thinking = '';
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]')
                continue;
            if (!trimmed.startsWith('data: '))
                continue;
            try {
                const json = JSON.parse(trimmed.slice(6));
                const deltaObj = json.choices?.[0]?.delta || {};
                const th = deltaObj.thinking || deltaObj.reasoning_content || deltaObj.reasoning || '';
                if (th) {
                    thinking += th;
                    onChunk(th, { kind: 'thinking' });
                }
                const ct = deltaObj.content || '';
                if (ct) {
                    text += ct;
                    onChunk(ct, { kind: 'content' });
                }
            }
            catch { /* malformed chunk */ }
        }
    }
    return { content: _stripThink(text), thinking: _stripThink(thinking) };
}
async function _readClaudeStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let thinking = '';
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: '))
                continue;
            try {
                const json = JSON.parse(trimmed.slice(6));
                if (json.type === 'content_block_delta') {
                    const delta = json.delta;
                    if (delta?.type === 'text_delta' && delta.text) {
                        text += delta.text;
                        onChunk(delta.text, { kind: 'content' });
                    }
                    else if (delta?.type === 'thinking_delta' && delta.thinking) {
                        thinking += delta.thinking;
                        onChunk(delta.thinking, { kind: 'thinking' });
                    }
                }
            }
            catch { /* malformed chunk */ }
        }
    }
    return { content: _stripThink(text), thinking: _stripThink(thinking) };
}
export { buildProviderClient, buildCustomClient, buildOllamaClient, buildOpenAICompatClient, buildClaudeClient, buildGeminiClient, buildGeminiWebClient, buildPerplexityClient, buildGrokClient, buildLMStudioClient };
