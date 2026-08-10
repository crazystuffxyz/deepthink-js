// src/mcp.js — MCP server exposing deepthink_reason
// runs as stdio (npm run mcp) or mounts at /mcp on the proxy (streamable HTTP)
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Deepthink, TraceStore } from '../dist/index.js';

const NAME = 'deepthink';
const VERSION = '1.0.0';

// one engine per model — proxy and MCP share the pool so concurrency scaling is global
const engines = new Map();
export function getEngine(model) {
  const m = model || process.env.DEEPTHINK_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b-cloud';
  if (!engines.has(m)) engines.set(m, new Deepthink(m));
  return engines.get(m);
}
export function destroyEngines() {
  for (const e of engines.values()) e.destroy();
  engines.clear();
}

// run one deepthink_reason call; returns MCP tool result
async function reason(args) {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) {
    return { isError: true, content: [{ type: 'text', text: 'prompt is required' }] };
  }
  const type = typeof args.type === 'string' && args.type ? args.type : 'string';
  const depth = Math.max(0, Math.min(3, Number(args.depth ?? 1) || 0));
  const enableCode = args.enableCode !== false;
  const trace = new TraceStore('flat', 500);
  const t0 = Date.now();
  try {
    const answer = await getEngine().generate(prompt, {
      type,
      depth,
      checks: depth > 0 ? 1 : 0,
      enableCode,
      _trace: trace,
    });
    const text = typeof answer === 'object' && answer !== null ? JSON.stringify(answer) : String(answer);
    return {
      content: [{ type: 'text', text }],
      structuredContent: { answer, type, depth, ms: Date.now() - t0, calls: trace.size },
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `deepthink_reason failed: ${err.message}` }] };
  }
}

export function createMcpServer() {
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  server.registerTool(
    'deepthink_reason',
    {
      title: 'DeepThink Reason',
      description:
        'Executes deep test-time compute reasoning, sandboxed code verification, MCTS tree search, and adversarial critique to solve hard mathematical, algorithmic, or multi-file coding problems.',
      inputSchema: {
        prompt: z.string().describe('The problem or question to reason about'),
        type: z
          .enum(['string', 'integer', 'double', 'boolean', 'json'])
          .optional()
          .describe('Expected output type (default string)'),
        depth: z.number().min(0).max(3).optional().describe('Reasoning depth 0-3 (default 1)'),
        enableCode: z.boolean().optional().describe('Allow sandboxed code execution (default true)'),
      },
    },
    reason
  );
  return server;
}

// stdio entry — Claude Desktop / Cursor CLI: node src/mcp.js
export async function runStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

// streamable HTTP — mount at /mcp on a Fastify app
// one Server + transport per session (Protocol.connect owns the transport's onmessage)
export function attachMcpRoutes(app) {
  const sessions = new Map(); // sessionId -> { server, transport }
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

// CLI: node src/mcp.js → stdio mode
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  runStdio().catch((e) => {
    console.error('mcp stdio failed:', e);
    process.exit(1);
  });
}
