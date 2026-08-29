# STATUS

Last updated: 2026-08-29 ~14:10 UTC
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

## Post-review round (2026-08-29 late)

- Proxy path parity completed: full `/api/*` ollama surface listed verbatim + `/v1/responses` (codex Responses API, full SSE event chain) + `/v1/completions` (legacy). `max` is its own tier now (d3/c3), `ultracode` aliases xhigh, Claude budget thresholds extend to ≥48k→max.
- `GET /_capture` ring inspector: last 50 bodies with `effortFields` (where effort hides per client) + resolved tier.
- **Verified live**: codex 0.150 `codex exec` → proxy → deepthink at `reasoning.effort=xhigh` completed a full agent turn (17,765 tokens). Codex default model resolves to gpt-5.6-sol — pass `-c model="gemma4:31b-cloud"` to run on the local daemon's lineup.
- Claude Code gateway is pinned by `~/.claude/settings.json` env (`http://localhost:11435` today) — shell/`--settings` overrides lose. To route Claude Code through this proxy: edit that one line to `http://localhost:11436`, then `/effort max` + prompt, then read `/_capture`.
- Proxy suite: 13/13 pass (adds Responses + capture-ring cases); README rewired.

## Notes for the operator

- Claude Code's gateway lives in the `env` block of `~/.claude/settings.json` (was `http://localhost:11435`); shell and `--settings` overrides lose to it. Flip that one line to `http://localhost:11436` to route Claude Code through this proxy (see `/_capture`).
- Kill spawned test servers by exact PID / TaskStop only — never `taskkill /T` (can kill the Claude Code host itself). Logged to `~/.claude/feedback/corrections.log`.

## Resume

- `npx tsc` → `npm run test:fast` → `npm test` (gemma4) → `node tests/test_effortProxy.js`.
- One RL cycle: `node scripts/rlLoop.js`. Long runs: `node scripts/rlLoop.js --loop 5`.
- Proxy: `npm run proxy:effort` then `DEEPTHINK_CAPTURE=1` for payload archaeology.
- AIME-style bench still the reference: plain 23/29 vs deepthink 24/29 (d2c2), pre-existing baseline intact.

## npm run proxy round (2026-08-29 final)
- `npm run proxy` is now the effort proxy on :11436 (`proxy:engine` keeps the :8000 always-engine mode).
- Model-agnostic: payload model wins (pooled per model, all 36 daemon models usable); no model in payload → DEEPTHINK_MODEL → OLLAMA_MODEL → gemma4:31b-cloud (when the daemon lists it).
- Why not 'first in tags': this daemon opens on glm-5.3:cloud (~60s think per call) and contains 410-retired shims — both verified live; the proven default avoids both traps. Verified: no-model request answered in 4.6s.
