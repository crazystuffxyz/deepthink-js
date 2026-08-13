// src/mcp-server/index.js
// assembles the full deepthink MCP server: one shared context, a registry of
// every tool, and the SDK wiring (stdio + streamable HTTP on the proxy).
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext } from './ctx.js';
import { installDispatch, tools } from './tools.js';
import { SCHEMAS, toZod } from './schemas.js';

const NAME = 'deepthink';
const VERSION = '2.0.0';

function titleCase(name) {
  return name
    .replace(/^deepthink_/, '')
    .replace(/^deep_/, 'deep ')
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// tools return plain values; shape them into an MCP tool result. an explicit
// ok:false becomes an error result so clients surface it as a failure.
function shape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (value && typeof value === 'object' && value.ok === false) {
    return { isError: true, content: [{ type: 'text', text: text.slice(0, 4000) }] };
  }
  return { content: [{ type: 'text', text: text.slice(0, 20000) }] };
}

function run(fn, args, ctx) {
  return Promise.resolve(fn(args || {}, ctx)).then(shape).catch((err) => ({
    isError: true,
    content: [{ type: 'text', text: `error: ${err.message}` }],
  }));
}

export function createMcpServer(opts = {}) {
  const ctx = createContext(opts);
  installDispatch(ctx);

  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  for (const [name, fn] of Object.entries(tools)) {
    const spec = SCHEMAS[name];
    server.registerTool(
      name,
      {
        title: titleCase(name),
        description: `deepthink tool: ${name}`,
        inputSchema: spec ? toZod(spec) : {},
      },
      (args) => run(fn, args, ctx)
    );
  }

  return server;
}

// stdio entry — Claude Desktop / Cursor CLI: node src/mcp.js
export async function runStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

// streamable HTTP — mount at /mcp on a Fastify app
export function attachMcpRoutes(app) {
  const sessions = new Map();
  const makeSession = () => {
    const server = createMcpServer();
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => sessions.set(sid, session),
    });
    const session = { server, transport: t };
    t.onclose = () => sessions.delete(t.sessionId);
    server.connect(t);
    return session;
  };
  app.get('/mcp', async (req, reply) => {
    const sid = req.headers['mcp-session-id'];
    const s = sid ? sessions.get(sid) : null;
    if (sid && !s) return reply.code(404).send({ error: 'unknown session' });
    if (!s) return reply.code(400).send({ error: 'missing mcp-session-id' });
    reply.hijack();
    await s.transport.handleRequest(req.raw, reply.raw);
  });
  app.post('/mcp', async (req, reply) => {
    const sid = req.headers['mcp-session-id'];
    let s = sid ? sessions.get(sid) : null;
    if (sid && !s) return reply.code(404).send({ error: 'unknown session' });
    if (!s) s = makeSession();
    reply.hijack();
    await s.transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.delete('/mcp', async (req, reply) => {
    const sid = req.headers['mcp-session-id'];
    const s = sid ? sessions.get(sid) : null;
    if (sid && !s) return reply.code(404).send({ error: 'unknown session' });
    if (!s) return reply.code(400).send({ error: 'missing mcp-session-id' });
    reply.hijack();
    await s.transport.handleRequest(req.raw, reply.raw);
  });
  return sessions;
}
