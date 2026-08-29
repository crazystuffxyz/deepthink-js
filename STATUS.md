# STATUS

Last updated: 2026-08-29 ~07:40 UTC
Session goal: ship the deepthink-js speed/search/proxy/bench/RL upgrade, tested on gemma4:31b-cloud.

## Done

- **Search stack rewritten** (`internet/ollamaSearch.ts`, `internet/interactWithInternet.ts`):
  - Layered engine: SearXNG -> ollama-native (device daemon `/api/experimental/web_search`, keyless when signed in; then ollama.com w/ `OLLAMA_API_KEY`; then JS SDK w/ auth headers) -> reformulated-query retry. No tier dead-ends on "no API key".
  - Daemon probe via free `POST /api/me` (cached, 4s timeout). 429 gets one spaced retry. 10-min per-query cache.
  - `getFetchResults` now memoizes extracted pages (kills the research pipeline's per-URL double fetch).
  - MCP `deepthink_web_search` (src/mcp-server/runner.js) routes through the same engine; raw DDG is the last resort.
- **Engine speed pass**:
  - `deepthink.ts`: probe wave + sandbox chain now run concurrently (was fully serial; saves 7-10 LLM round-trips on the critical path).
  - `consensusText` excluded from thinkCtx dump (dedup token waste).
  - Blind checkers num_predict 150 -> 1000 (kills spurious NO verdicts from truncated re-derivations).
  - `providers/index.ts`: Ollama client cached per host|key; default `keep_alive: '30m'` for local models; all non-ollama adapters get hang-guarded fetch (`HTTP_TIMEOUT_MS`, 5 min).
  - `codeGenerator/python.ts`: MCTS approach generation parallelized (domains pre-assigned).
  - `mullvadLetaClient.ts`: instance-list fetch capped at 3s.
  - `researchAgent.ts`: broadened-query retry when the crawl returns 0 raw results (was a guaranteed dead run).
- Live smoke on gemma4:31b-cloud (local daemon, logged in): `17*23 -> 391` (depth2+checks+mcts, 11.3s), `Canberra, Australia` (depth1). `npx tsc` clean, `test:fast` 100% pass.
- Full suite (`npm test`, gemma4:31b-cloud) running in background.

## In progress / next

1. Full suite results -> fix anything red.
2. Task #7: effort-aware universal proxy on :11436 (ollama-compatible passthrough + OpenAI/Anthropic/Grok/Gemini wire formats; thinking/effort params -> deepthink depth/checks). Research payload shapes (ollama `think: bool|"low"|"medium"|"high"`, OpenAI `reasoning_effort`, Anthropic `thinking.budget_tokens`, Gemini `thinkingConfig.thinkingBudget`). Hello-world capture experiment with a child claude pointed at the proxy. Stop spawned servers by targeted PID only -- NEVER taskkill the parent process tree.
3. Task #4: benchmark upgrade (latency + search-quality metrics; new sets) + real gemma4:31b-cloud run recorded in benchmarks/results.
4. Task #5: `scripts/rlLoop.js` always-on loop (evolve -> OOD probe -> apply best -> bench delta -> `data/evolved/rl-state.json`), wired into npm scripts.
5. Task #6: README/CHANGELOG updates (humanized), final commits as crazystuffxyz (no AI attribution).

## Metrics

- `test:fast`: 100% pass (11 files).
- AIME 2024 baseline (pre-change): plain 23/29 vs deepthink 24/29 @ depth2+checks2.
- gemma4 smoke: depth2+checks+mcts integer = 11.3s.

## Resume

- Build: `npx tsc`. Fast tests: `npm run test:fast`. Full: `npm test`.
- Daemon probe that confirms device search: `curl -s -X POST http://localhost:11434/api/experimental/web_search -d '{"query":"test","max_results":3}'`.
- Search engine smoke: `node -e "const {getSearchResults} = await import('./dist/internet/interactWithInternet.js'); console.log(await getSearchResults('test ollama cloud', 3))"` -- `node --input-type=module` or `.mjs`.