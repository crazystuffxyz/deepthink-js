// tests/test_proxy.js — smoke test for the OpenAI/Anthropic proxy
// boots the proxy on an ephemeral port, hits every endpoint, checks shapes
import { startProxy, stopProxy } from '../src/proxy.js';

const MODEL = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';
const PROMPT = 'Reply with exactly: hello world';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok - ${name}`);
  } else {
    fail++;
    console.log(`  FAIL - ${name} ${extra}`);
  }
}

// read a full SSE stream from a fetch response
async function readSSE(res) {
  let text = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

const app = await startProxy(0);
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'x-deepthink-model': MODEL };

try {
  // --- GET /v1/models ---
  {
    const res = await fetch(`${base}/v1/models`);
    const body = await res.json();
    check('GET /v1/models 200', res.status === 200, `got ${res.status}`);
    check('models list shape', body.object === 'list' && Array.isArray(body.data) && body.data.length > 0);
  }

  // --- POST /v1/chat/completions (non-streaming) ---
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o', // ignored — deepthink model comes from the header
        messages: [{ role: 'user', content: PROMPT }],
        deepthink: { depth: 1, checks: 0 },
      }),
    });
    const body = await res.json();
    check('chat completions 200', res.status === 200, `got ${res.status}`);
    check('chat completion shape', body.object === 'chat.completion' && body.choices?.[0]?.message?.content?.length > 0, JSON.stringify(body).slice(0, 200));
    check('usage present', typeof body.usage?.total_tokens === 'number');
  }

  // --- POST /v1/chat/completions (streaming SSE) ---
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: PROMPT }],
        stream: true,
        stream_options: { include_usage: true },
        deepthink: { depth: 1, checks: 0 },
      }),
    });
    const sse = await readSSE(res);
    check('streaming 200', res.status === 200, `got ${res.status}`);
    check('content-type is SSE', (res.headers.get('content-type') || '').includes('text/event-stream'));
    check('has [DONE] terminator', sse.includes('data: [DONE]'));
    check('has content deltas', /"delta":\{"content":"[^"]+/.test(sse), sse.slice(0, 300));
    check('has finish_reason', sse.includes('"finish_reason":"stop"'));
    check('has usage chunk', sse.includes('"usage"'));
  }

  // --- POST /v1/messages (Anthropic, non-streaming) ---
  {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-3-5-sonnet', // ignored
        max_tokens: 100,
        messages: [{ role: 'user', content: PROMPT }],
        deepthink: { depth: 1, checks: 0 },
      }),
    });
    const body = await res.json();
    check('messages 200', res.status === 200, `got ${res.status}`);
    check('message shape', body.type === 'message' && body.content?.[0]?.type === 'text' && body.content[0].text.length > 0, JSON.stringify(body).slice(0, 200));
    check('stop_reason end_turn', body.stop_reason === 'end_turn');
  }

  // --- trace header ---
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'x-deepthink-trace': 'true' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: PROMPT }],
        deepthink: { depth: 1, checks: 0 },
      }),
    });
    const body = await res.json();
    check('trace header set', res.headers.get('x-deepthink-trace-id') !== null);
    check('reasoning_content present', typeof body.choices?.[0]?.message?.reasoning_content === 'string');
    check('_deepthink trace present', Array.isArray(body._deepthink?.trace));
  }

  // --- error path ---
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [] }),
    });
    const body = await res.json();
    check('empty messages -> 400', res.status === 400 && body.error?.message?.includes('messages'));
  }

  // --- /mcp streamable HTTP (MCP over URL) ---
  {
    const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const readSSE = async (res) => {
      let text = '';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      const lines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
      return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    };
    const init = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test_proxy', version: '0.0.1' } } }),
    });
    const sid = init.headers.get('mcp-session-id');
    const initBody = await readSSE(init);
    check('mcp initialize 200 + session', init.status === 200 && !!sid, `got ${init.status}`);
    check('mcp serverInfo', initBody?.result?.serverInfo?.name === 'deepthink');
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...H, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const list = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...H, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listBody = await readSSE(list);
    check('mcp tools/list has deepthink_reason', listBody?.result?.tools?.some((t) => t.name === 'deepthink_reason'));
    const call = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...H, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'deepthink_reason', arguments: { prompt: PROMPT, depth: 1, enableCode: false } } }),
    });
    const callBody = await readSSE(call);
    check('mcp tools/call returns answer', !callBody?.result?.isError && (callBody?.result?.content?.[0]?.text || '').length > 0);
    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    check('mcp DELETE session', del.status === 200, `got ${del.status}`);
  }
} finally {
  await stopProxy();
}

console.log(`\ntest_proxy: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
