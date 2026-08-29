// tests/test_effortProxy.js — effort proxy: passthrough + effort->engine + wire framings.
// uses a real listening socket (ephemeral port) — app.inject can't complete
// hijacked SSE responses.
process.env.DEEPTHINK_PROXY_NO_LISTEN = '1';
const { app } = await import('../src/effortProxy.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
await app.ready();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + app.server.address().port;
const post = async (path, payload, timeoutMs) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
  } finally { clearTimeout(t); }
};

// 1. ollama chat + think level -> engine, ollama NDJSON framing
{
  const r = await post('/api/chat', { model: 'gemma4:31b-cloud', messages: [{ role: 'user', content: 'What is 2+2? one word' }], stream: false, think: 'low' }, 150_000);
  const body = await r.json().catch(() => ({}));
  ok('think:"low" -> ollama framing (message + done)', body?.done === true && body?.message?.role === 'assistant', JSON.stringify(body).slice(0, 120));
  ok('engine effort header present', r.headers.get('x-deepthink-effort') === 'low', String(r.headers.get('x-deepthink-effort')));
}
// 2. no effort -> passthrough (daemon answers, no x-deepthink header)
{
  const r = await post('/api/chat', { model: 'gemma4:31b-cloud', messages: [{ role: 'user', content: 'Say OK' }], stream: false }, 60_000);
  const body = await r.json().catch(() => ({}));
  ok('no-effort -> daemon passthrough', !r.headers.get('x-deepthink-effort') && body?.done !== undefined, JSON.stringify(body).slice(0, 120));
}
// 3. anthropic thinking budget -> SSE with valid event chain
// budget 8000 maps to the medium tier — cheap call, still exercises the
// budget->tier mapping and the full Anthropic SSE chain
{
  const r = await post('/v1/messages', { model: 'gemma4:31b-cloud', max_tokens: 256, stream: true, thinking: { type: 'enabled', budget_tokens: 8000 }, messages: [{ role: 'user', content: 'hi' }] }, 240_000);
  const text = await r.text();
  ok('anthropic message_start', text.includes('"type":"message_start"'));
  ok('anthropic text_delta', text.includes('"type":"text_delta"'));
  ok('anthropic message_stop', text.includes('"type":"message_stop"'));
}
// 4. openai reasoning_effort string -> engine chat.completion
{
  const r = await post('/v1/chat/completions', { model: 'gemma4:31b-cloud', reasoning_effort: 'low', messages: [{ role: 'user', content: 'What is 2+2? one word' }] }, 150_000);
  const body = await r.json().catch(() => ({}));
  ok('reasoning_effort -> chat.completion', body?.object === 'chat.completion' && !!body?.choices?.[0]?.message?.content, JSON.stringify(body).slice(0, 120));
}
// 5. passthrough GET rides to daemon
{
  const r = await fetch(base + '/api/version');
  ok('GET passthrough /api/version', r.status === 200 && (await r.json()).version?.length > 0);
}
// 6. ollama /api/generate with think level + stream:true -> generate-shaped NDJSON
{
  const r = await post('/api/generate', { model: 'gemma4:31b-cloud', prompt: 'What is 2+2? one word', stream: true, think: 'low' }, 150_000);
  const lines = (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  ok('generate stream returns generate-shaped NDJSON + done', lines.length > 0 && last?.done === true && typeof last.response === 'string', `last=${JSON.stringify(last).slice(0, 100)}`);
  ok('no SSE comment lines inside NDJSON stream', lines.every((l) => typeof l === 'object'));
}
// 7. codex wire: /v1/responses with reasoning.effort -> engine, Responses events
{
  const r = await post('/v1/responses', { model: 'gemma4:31b-cloud', instructions: 'Answer tersely.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is 2+2? one word' }] }], stream: true, reasoning: { effort: 'low' }, store: false }, 150_000);
  const text = await r.text();
  ok('responses created+completed events', text.includes('"type":"response.created"') && text.includes('"type":"response.completed"'), text.slice(0, 120));
  ok('responses output_text.delta present', text.includes('response.output_text.delta'));
}
// 8. /_capture shows where effort was found
{
  const r = await fetch(base + '/_capture');
  const j = await r.json();
  ok('/_capture ring exposes effort fields', j.count >= 5 && typeof j.entries[0].effort === 'string', `count=${j.count}`);
}

console.log(`\n  ${pass} pass, ${fail} fail`);
await app.close();
process.exit(fail ? 1 : 0);