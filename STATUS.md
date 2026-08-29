# STATUS

Last updated: 2026-08-29 ~08:55 UTC
Session goal: ship the deepthink-js speed/search/proxy/bench/RL upgrade, tested on gemma4:31b-cloud.

## FINISHED

- **Layered search, no dead ends** (`internet/ollamaSearch.ts`, `interactWithInternet.ts`):
  SearXNG → signed-in device daemon (`/api/experimental/web_search`, keyless) → ollama.com key tier → SDK → keyword-reformulated retry. Empty verdicts never cached (transient outages can't poison 10 min of lookups); page extractions memoized with a 10-min TTL.
- **Engine speed** (`deepthink.ts`, `providers/index.ts`, `python.ts`): probe wave ∥ sandbox chain; MCTS approaches parallel (pre-assigned domains); client pool per host|key+headers; 30-min keep-alive on locals; blind checkers 1000 tokens; hang-guarded fetch on all adapters.
- **Effort proxy** (`src/effortProxy.js`, `npm run proxy:effort`, :11436): full ollama passthrough; effort payloads (`reasoning_effort`, `thinking.budget_tokens`, `think` string levels, Gemini `thinkingBudget`, `x-deepthink-effort`) re-run through deepthink and re-framed as ollama NDJSON / OpenAI chunks / Anthropic SSE / Gemini (alt=sse + JSON-array forms). Code-review findings fixed: generate-stream shape, NDJSON without SSE comments, heartbeat only on SSE.
- **RL loop** (`scripts/rlLoop.js`, `npm run rl`): light evolve → full-bank re-score → OOD probe → regression guard → `data/evolved/rl-state.json`; champion mirrored to `data/evolved/rl-best/summary.json` (loadBest-compatible; verified).
- **Benchmarks**: `npm run bench:latency` harness + results; `run.js` honors `BENCH_MODEL`; MCP `deep_research` accepts `useOllamaSearch`/thresholds.
- **Docs**: README (search/proxy/RL/latency sections, v2.0.1 notes), CHANGELOG v2.0.1 — humanized. Test surface: `test:fast` 100%, full `npm test` 19/19, `test_effortProxy.js` live.

## Metrics (gemma4:31b-cloud via local daemon)

- Latency (6 questions): plain 258ms p50 / 371ms p90 · dt d1c0 4.47s / 6.81s · dt d2c1 4.49s / 6.80s.
- RL cycle 1: fitness 0.948 (mini-batch) → 0.828 full bank, OOD 0.300 (gap 0.528 — known bench-hardness band), champion `c-0008` promoted in 234s.
- gemma4 smoke: `17*23 → 391` (d2+c1+mcts, 11.3s); full suite 19/19; test:fast 100%.
- Search smoke: layered engine 5 results in 624ms via device tier (no key set); cached rerun 0ms; reformulate path live.

## Notes for the operator

- Claude Code on this machine pins its gateway via managed settings; `--settings <file>` env blocks pass the model name through but still hit first-party (observed ~$0.18 per hello-world). Point Cursor/Aider at the proxy instead, or proxy via `DEEPTHINK_CAPTURE` to log payload shapes.
- Kill spawned test servers by exact PID / TaskStop only — never `taskkill /T` (can kill the Claude Code host itself). Logged to `~/.claude/feedback/corrections.log`.

## Resume

- `npx tsc` → `npm run test:fast` → `npm test` (gemma4) → `node tests/test_effortProxy.js`.
- One RL cycle: `node scripts/rlLoop.js`. Long runs: `node scripts/rlLoop.js --loop 5`.
- Proxy: `npm run proxy:effort` then `DEEPTHINK_CAPTURE=1` for payload archaeology.
- AIME-style bench still the reference: plain 23/29 vs deepthink 24/29 (d2c2), pre-existing baseline intact.