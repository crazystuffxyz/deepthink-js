// test_mcp.js — the MCP server tool set: registration + pure-tool behavior
'use strict';

import os from 'os';
import path from 'path';
import fs from 'fs';
import { createContext } from '../src/mcp-server/ctx.js';
import { installDispatch, tools } from '../src/mcp-server/tools.js';
import { SCHEMAS } from '../src/mcp-server/schemas.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt_mcp_'));
const ctx = createContext({ memoryPath: path.join(tmp, 'mem.json') });
installDispatch(ctx);

// every tool in the schema registry must be wired to a handler
const missing = Object.keys(SCHEMAS).filter((n) => !tools[n]);
ok(missing.length === 0, `all schemas have handlers, missing: ${missing.join(', ')}`);
ok(Object.keys(tools).length >= 60, `expected 60+ tools, got ${Object.keys(tools).length}`);

// pure utility tools
const t = await tools.get_current_time({}, ctx);
ok(typeof t === 'string' && t.length > 0, 'get_current_time returns a time string');
const e = await tools.echo_message({ message: 'hi' }, ctx);
eq(e.echo, 'hi', 'echo_message round-trips');
const d = await tools.roll_dice({ sides: 6 }, ctx);
ok(d.result >= 1 && d.result <= 6, 'roll_dice within range');
const c = await tools.coin_flip({}, ctx);
ok(['heads', 'tails'].includes(c.result), 'coin_flip result');
const r = await tools.random_number({ min: 1, max: 3 }, ctx);
ok(r.result >= 1 && r.result <= 3, 'random_number within range');
const log = await tools.get_event_log({ limit: 5 }, ctx);
ok(Array.isArray(log.events), 'get_event_log returns array');

// memory store
await tools.deepthink_memory_set({ namespace: 'n', key: 'k', value: { a: 1 } }, ctx);
const g = await tools.deepthink_memory_get({ namespace: 'n', key: 'k' }, ctx);
eq(g.value, { a: 1 }, 'memory set/get');
const s = await tools.deepthink_memory_search({ namespace: 'n', query: 'a' }, ctx);
ok(s.results.length >= 1, 'memory search finds key');
const l = await tools.deepthink_memory_list({ namespace: 'n' }, ctx);
ok(l.keys.length >= 1, 'memory list');
await tools.deepthink_memory_delete({ namespace: 'n', key: 'k' }, ctx);
const g2 = await tools.deepthink_memory_get({ namespace: 'n', key: 'k' }, ctx);
ok(g2.value === null, 'memory delete removes key');
const gc = await tools.deepthink_memory_gc({}, ctx);
ok(gc.ok === true, 'memory gc runs');

// code intelligence on a scratch project
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
fs.writeFileSync(path.join(proj, 'a.js'), 'function hello() { return 1; }\nconst x = 2;\n');
fs.writeFileSync(path.join(proj, 'sub', 'b.js'), 'export const y = 3;\n');
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'p', dependencies: { lodash: '^4' } }));
const sc = await tools.deepthink_search_code({ root: proj, query: 'hello' }, ctx);
ok(sc.matches.length >= 1, 'search_code finds hello');
const ff = await tools.deepthink_find_files({ root: proj, namePattern: '*.js' }, ctx);
ok(ff.files.length >= 2, 'find_files finds js files');
const po = await tools.deepthink_project_overview({ root: proj }, ctx);
ok(po.totalFiles >= 3, 'project_overview counts files');
const lf = await tools.deepthink_list_functions({ file: path.join(proj, 'a.js') }, ctx);
ok(lf.functions.some((f) => f.name === 'hello'), 'list_functions finds hello');
const ad = await tools.deepthink_audit_deps({ root: proj }, ctx);
ok(ad.name === 'p', 'audit_deps reads package.json');
const im = await tools.deepthink_import_map({ root: proj }, ctx);
ok(typeof im.imports === 'object', 'import_map returns an imports map');

// document parsing
const jf = path.join(tmp, 'doc.json');
fs.writeFileSync(jf, '{"x": 1}');
const pd = await tools.deepthink_parse_document({ path: jf }, ctx);
ok(pd.ok && pd.type === 'json' && pd.value.x === 1, 'parse_document reads json');

// filesystem primitives + rollback
const f1 = path.join(tmp, 'w.txt');
await tools.deepthink_write_file({ path: f1, content: 'one' }, ctx);
const rf = await tools.deepthink_read_file({ path: f1 }, ctx);
ok(rf.content === 'one', 'write/read file');
const f2 = path.join(tmp, 'copy.txt');
await tools.deepthink_copy_file({ src: f1, dest: f2 }, ctx);
ok(fs.existsSync(f2), 'copy_file creates dest');
const ld = await tools.deepthink_list_dir({ path: tmp }, ctx);
ok(ld.entries.length >= 1, 'list_dir');
await tools.deepthink_delete_file({ path: f2 }, ctx);
ok(!fs.existsSync(f2), 'delete_file removes');
const rb = await tools.deepthink_rollback({}, ctx);
ok(typeof rb.undone === 'number' && rb.undone >= 0, 'rollback returns undone count');

// LLM tools are registered (not called — no ollama in CI)
for (const n of ['deep_research', 'deepthink_generate', 'deepthink_json', 'deepthink_humanize_text', 'deepthink_process', 'deepthink_agent', 'deepthink_mcts_search', 'deepthink_design_svg']) {
  ok(typeof tools[n] === 'function', `${n} registered`);
}

console.log('test_mcp: all assertions passed');
ctx.pool.close();
