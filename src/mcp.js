// src/mcp.js — MCP server entry
// runs as stdio (npm run mcp) or mounts at /mcp on the proxy (streamable HTTP).
// the full tool set lives in src/mcp-server/; this file just wires it up and
// keeps the getEngine/destroyEngines surface the proxy imports.
import { getEngine, destroyEngines } from './mcp-server/engine.js';
import { createMcpServer, runStdio, attachMcpRoutes } from './mcp-server/index.js';

export { getEngine, destroyEngines, createMcpServer, runStdio, attachMcpRoutes };

// CLI: node src/mcp.js → stdio mode
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  runStdio().catch((e) => {
    console.error('mcp stdio failed:', e);
    process.exit(1);
  });
}
