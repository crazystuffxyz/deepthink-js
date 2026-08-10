// tests/test_mcp.js — smoke test for the stdio MCP server
// spawns node src/mcp.js, speaks JSON-RPC over stdin/stdout, calls deepthink_reason
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.DEEPTHINK_TEST_MODEL || 'gemma4:31b-cloud';

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

const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], {
  env: { ...process.env, DEEPTHINK_MODEL: MODEL },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map(); // id -> resolve
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 120000);
  });
}

try {
  // initialize handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test_proxy', version: '0.0.1' },
  });
  check('initialize ok', init.result?.serverInfo?.name === 'deepthink', JSON.stringify(init).slice(0, 200));
  check('protocolVersion echoed', init.result?.protocolVersion === '2025-03-26');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // tools/list
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  const tool = tools.find((t) => t.name === 'deepthink_reason');
  check('tools/list has deepthink_reason', !!tool);
  check(
    'description matches spec',
    tool?.description ===
      'Executes deep test-time compute reasoning, sandboxed code verification, MCTS tree search, and adversarial critique to solve hard mathematical, algorithmic, or multi-file coding problems.'
  );
  check('input schema has prompt', tool?.inputSchema?.properties?.prompt?.type === 'string');
  check('input schema has depth', tool?.inputSchema?.properties?.depth?.type === 'number');

  // tools/call — real deepthink run
  const call = await rpc('tools/call', {
    name: 'deepthink_reason',
    arguments: { prompt: 'Reply with exactly: hello world', depth: 1, enableCode: false },
  });
  const result = call.result;
  check('tools/call ok', !result?.isError, JSON.stringify(call).slice(0, 300));
  const text = result?.content?.[0]?.text || '';
  check('answer returned', text.length > 0, text.slice(0, 100));
  check('structuredContent present', result?.structuredContent?.answer !== undefined);

  // error path — missing prompt
  const bad = await rpc('tools/call', { name: 'deepthink_reason', arguments: {} });
  check('missing prompt -> isError', bad.result?.isError === true);
} finally {
  proc.kill();
}

console.log(`\ntest_mcp: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
