# Changelog

## v1.8.9

### Fixed
- **52-week-range price sanity check** — run 16: the $8.00 quote glitch struck a third time, and this time no shares-outstanding claim was harvested, so the market-cap ÷ shares cross-check had nothing to divide by. The same claims carried the 52-week range ("traded between $164.07 and $236.54") — a quote more than 2× below the 52-week LOW or above the HIGH is now rejected the same way an off-by-2× implied-price quote is. The implied price wins when available; otherwise the price is dropped and the quote-recovery crawl fires. `priceSource` is now returned on the model so the rejection is visible.
- **Section overlap from order-based chunking** — run 15: 5 chunks × 4 subheadings each = 21 `##` sections, with "Industry Status Quo" appearing in 3 different chunks because claims were chunked by ORDER, not theme. Claims are now theme-clustered (one LLM call groups them into K distinct-theme clusters; every index must be covered exactly once or the original order is kept) before chunking, and the writer's subheadings drop to `###` so the `##` level stays reserved for top-level sections.
- **Coverage-gaps disclaimer shipped before the Executive Summary** — run 15: "## Coverage Gaps" was the report's first section, violating the "Executive Summary must lead" structural rule. The disclaimer now lands after the Conclusion, before References — transparency kept, placement fixed.
- **Citation tag spam** — run 15: "[Source 1, Source 1, Source 1...]" ×16 — the same source page produced several claims that all merged into one node, and the duplicate URLs all mapped to the same ref id. `mergeDuplicateClaims` now dedupes URLs/srcMeta on merge, and the writer dedupes ref ids per claim.
- **Login-wall titles in References** — run 15: a reference titled "Create Account - FinanceCharts.com" (the page's `<title>` tag behind a login wall). `sanitizeTitle` rejects login/bot-blocker titles ("Create Account", "Just a moment...", "Access Denied", "404"...), and the ref builder falls back to a URL-derived title ("eps-diluted-ttm" → "EPS Diluted TTM").
- **Domain expert critic parse failures** — run 16: the critic's JSON failed to parse in every loop because LLMs mangle enum values ("minor revision" with a space, "Critical" capitalized) and one bad value kills the whole Zod parse. All LLM-facing enums now normalize case/whitespace before validation (`normEnum`).
- **Humanize internals silent** — the humanize loop's per-iteration logs (detector scores, radical escalation) never reached the pipeline log because `opts.log` was never passed through. Now wired.

## v1.8.8

### Fixed
- **Growth rates harvested as EPS** — run 15: "TTM EPS growth is 214.42%" — the EPS window crossed "growth is" and captured the growth RATE as the EPS value ($214.42 EPS → IV $52,671/share on a $217 stock). The EPS harvest now bans growth/cagr/rate words between the anchor and the number, and a `%` sign within 8 chars after it (the window is short so it can't cross into the next claim's percentage). Same guard class as the P/E multiple ban in v1.8.4.
- **Survey shares harvested as growth** — run 15: "54% expect that growth to be 11% or more" — the loose `[\s\S]` growth windows crossed "2026, and" and grabbed the survey share (54%) as the growth rate. The `%`→growth-word gap is now tight (a "26% increase" is 0-2 chars; "54% expect that growth" is 13), and the post-growth window is digit-safe so it can't cross a year to reach a later number. EPS CAGR ("3-year EPS CAGR of 64%") is added as a legit annualized-growth fallback.
- **Unbounded DCF growth** — the constant-growth DCF projected whatever CAGR the sources claimed for a full decade (71% TTM EPS CAGR → IV $4,309). The projection is now capped at 30% (sustainable-growth assumption, stated in the section) and fades linearly to the 3% terminal rate over the horizon — standard analyst practice, and the verdict becomes insensitive to which CAGR claim the harvest happens to pick first.

## v1.8.7

### Fixed
- **Recovery crawl string/object crash** — run 14: `recoverStockQuote` passes plain query strings to `crawlerAgent`, which destructured `{ query, goal, depth, topic }` from them — `query` came out `undefined`, the search crashed on `query.slice(0, 60)`, and the recovery crawl silently returned 0 URLs (quant model dead despite 103 verified claims). `crawlerAgent` now normalizes string items to `{ query: item, goal: '', depth: 0, topic: 'general' }` before use. The search chain is hardened the same way: `getSearchResults` and `getMullvadLetaResults` coerce `query ?? ''` and bail on empty, and the Ollama client-tier probe no longer crashes when a rejected promise carries no error value.

## v1.8.6

### Fixed
- **SearXNG instance rotation** — run 13: searx.space URLs carry trailing slashes, but the tried-set held the stripped `baseUrl` while the shuffle held unstripped entries — the `find` never matched, so all 8 attempts hammered the same rate-limited instance (5 URLs from 6 queries, 1 extractable source, quant model dead). The instance list is now normalized once before shuffling; a 403 on one instance rotates to a working one (verified live: 20 results from the second instance).

## v1.8.5

### Fixed
- **PEG/forward-P/E parenthetical capture** — run 12: "PEG Ratio (5yr expected): 0.55" — the lazy `[^0-9]{0,40}` window stopped at the "5" in "(5yr", so growth derived as 4.6% (22.88 ÷ 5) instead of 41.6% (22.88 ÷ 0.55). Both regexes now use the parenthetical-skip pattern `(?:\s*\([^)]*\)|[^0-9]){0,40}` the beta regex already had.
- **Implied-price cross-check (market cap ÷ shares)** — runs 9/12: the Yahoo quote page glitched to "$8.00" and every claim repeated it, so cluster consensus had nothing sane to cluster against. The engine now also harvests market capitalization and shares outstanding and computes the implied price (4.86T ÷ 24.2B = $200.83). A harvested quote more than 2× off the implied price is rejected as implausible; a missing quote is filled by the implied price. A sane quote within 2× is kept.

## v1.8.4

### Fixed
- **P/E multiples never harvested as price** — run 11: "trades at 27 times forward earnings" is a valuation multiple, but the `trades at` anchor captured 27.00 as the current price and the whole model computed against it. `harvestAll` gains a post-match banned check (25 chars after the capture): `x` directly after the number, `times` (word-bounded), `forward earnings`, `multiple`, `p/e`, `pe ratio` all disqualify. `scanPriceForwardAll` gets the same guard, and the conformance sweep's price rules reject a trailing `x` and ban `times`/`multiple`.

## v1.8.3

### Fixed
- **Humanize loop never touches the References section** — run 10: a humanize rewrite dropped the entire References section (the integrity check only catches individual claims — `[Source N]` tags and numbers — and the references carry neither). `humanizeText` now splits the report at the References marker, humanizes the body only, and re-attaches the tail verbatim — the same protection the conformance sweep already had.

## v1.8.2

### Fixed
- **Quant section injected after humanize** — run 10: the humanize loop ran *after* the computed quant section was injected and paraphrased code-computed math ("volatility: NOT FOUND" became "volatility: 08, 24, 28, 29"). The section now lands after the humanize loop, so no LLM pass (critic, repair, or humanizer) can touch it.
- **Quote recovery covers all missing inputs** — the recovery crawl only fired on a missing *price* and only asked for quotes. It now triggers on any missing input (price, EPS, beta) and issues per-field phrasings ("diluted EPS trailing twelve months", "beta 5 year monthly") at higher concurrency. Run 10's main crawl surfaced only industry articles, so all three were missing and the model died.

## v1.8.1

### Fixed
- **Cluster-based price/beta consensus** — run 9: a glitched quote page claimed "current price $8.00 (Closed)" and repeated it across claims, and plain plurality picked the bogus $8.00 over the real ~$217 cluster. Candidates are now grouped into clusters (values within 25% of each other), the LARGEST cluster wins, and the mode within it is the price. A genuinely cheap stock still clusters at its own level — no arbitrary "plausible price" threshold. Applied to beta too.
- **After-hours quote ban** — "after-hours price of NVDA is $8.00" is not the current price, but the qualifier sat *before* the anchor match, so the banned-word check never saw it. The banned check now also looks 25 chars before the match (both `harvest`/`harvestAll` and `scanPriceForwardAll`).

## v1.8.0

### Added
- **Consensus price & beta harvesting** — when sources disagree on the current quote ($217.55 from four sources vs $223.96 from one), the engine now pools every price/beta candidate and takes the MODE, so the pipeline's number matches the one the writer sees cited most often. Engine and report prose converge instead of fighting each other.
- **Deterministic quant conformance sweep** (`quantConformanceRepair`) — when the quant engine computes a model, the pipeline *enforces* its numbers in the report prose: every metric-anchored number (price, EPS, beta, volatility, cost of equity/WACC/discount rate, intrinsic value, E[S_T], expected returns, Sharpe, all three VaR horizons) is mechanically rewritten to the engine's value. Zero LLM in the step. Runs once before the critique loop (critics verify the aligned report) and once after (repair passes re-introducing writer-style numbers get swept again). The run-7 divergence — prose "$254.71 expected price / $241.18 IV / WACC 9.5%" vs computed "$258.87 / $1256.65 / Re 14.49%" — cannot ship anymore.
- **Per-URL citation metadata** — merged duplicate claims keep each source's own title/citation (`srcMeta`), so the References section lists every URL with *its* page's metadata instead of the first source's title on four different URLs.
- **Critique-loop regression guard** — the loop now tracks the best-scoring report version; a repair pass that stalls (<20% improvement) or regresses (54 → 28 → 39) restores the best version instead of shipping the damage, and the loop-cap path does the same.
- **Quant engine regression tests** (`tests/test_quantEngine.js`, 25 model-free checks) — price/beta consensus, price-target rejection, the full run-7 divergence alignment, negative cases (quarterly EPS, volatility drag, forecast guidance, horizon-specific VaR untouched), EPS annual preference, wordy-phrase price recovery, and merged-claim metadata.

## v1.7.0

### Added
- **Pipeline-computed quant engine** (`thinking/quantEngine.ts`) — stock research reports now contain real math, not LLM-asserted math. The engine harvests inputs from the *verified* claims (price, EPS, beta, volatility, risk-free rate, ERP), derives growth the way an analyst would (forward P/E ÷ PEG when no explicit growth % is cited), and computes CAPM cost of equity, a genuine 10-year DCF with Gordon terminal value → intrinsic value per share, GBM expected return with Ito's drift correction (μ − σ²/2), Sharpe, and 1-day/1-year VaR. The report writer is told to use these exact numbers and a `## Quantitative Model (computed by pipeline)` section with full derivations is injected after the critique loop so no critic or repair pass can rewrite code-computed math.
- **Quote recovery crawl** — if stock mode finds no current price in the verified claims, one targeted quote query is crawled and verified before the quant model gives up.
- **Quant verifier ground truth** — the quant finance critic now receives the pipeline's computed values and flags any report number that differs from them (deterministic anchor instead of re-derivation from the report's own prose).
- **Anti-hallucination stock writer** — when the quant engine cannot compute (missing price/EPS/beta), the writer is explicitly forbidden from inventing models (Monte Carlo, jump-diffusion), expected returns, or risk figures.
- **Cross-source claim dedup** — duplicate facts cited by multiple sources are merged into one claim node carrying both URLs (writer emits `[Source 1, Source 2]`). Number normalization folds "81.61 billion" and "$81.61B" into the same key, and 1-decimal fuzzy matching merges near-equal figures ("diluted EPS 6.53" vs "6.54") that different sources round differently.
- **Citation author sanitization** (`internet/extractCitation.ts`) — rejects Readability byline junk ("9.5 French Competition Authority investigation" section headings from Wikipedia) and implausible authors before they land in the 9-style citation sets.

### Changed
- Critique loop: domain expert now performs structural checks (Executive Summary must lead, no duplicate sections, conclusion answers with specifics); convergence guard stops when repair improves <20%.
- Humanize loop: the previous detector pass's "tells" are fed into the next humanize pass so rewrites target the actual AI signals instead of guessing blind; plateau guard stops when two consecutive scores don't improve.
- **Harvest hardening** (run 6: 113 claims, yet price/EPS "NOT FOUND" — regexes died on real phrasing): windows now cross digits ("EPS for Q3 FY2026 stood at $1.30"), lazy first-number-wins semantics ("volatility is 45%, up from 40%" → 45), year-like capture rejection with per-anchor rescan ("share price for fiscal 2026 was $150.42" → 150.42), price-TARGET guard (target/forecast/guidance hits are never current price), `vol(?!ume)` so trading volume can't masquerade as volatility, and EPS annual-preference scoring (annual/TTM beats quarterly, so Q3 EPS never feeds the annual DCF).
- **Search-quality defenses** (run 5: the crawl returned Chinese Q&A spam and extraction failed 0/10): Q&A spam domains (zhihu/baidu/zybang/…) penalized -60 in credibility scoring, CJK-heavy titles/snippets -45, CJK-heavy page content rejected pre-extraction, and a spam-quarantine retry re-crawls with `-site:` exclusions when every result is filtered.
- **Stock-mode guarantees**: plannerAgent always includes a current-price query (prompt rule + deterministic backstop); `recoverStockQuote` uses 4 query phrasings at a lower credibility threshold with more sources.
- **Invented-math purge**: when the quant engine cannot compute, a post-critique repair pass strips fabricated GBM/VaR/Sharpe/DCF claims from the shipped report (run 6's writer invented "trading at $150" + a 0.36 Sharpe despite the anti-hallucination note — prompts are not guarantees).
- `mergeDuplicateClaims` and `recoverStockQuote` exported for testing.

## v1.6.0

### Added
- **Local HTTP proxy** (`src/proxy.js`, `npm run proxy`) — Fastify server on `http://127.0.0.1:8000` that speaks OpenAI and Anthropic wire formats over the deepthink pipeline. `POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/messages`, plus `/health`. Any OpenAI/Anthropic-compatible tool (Cursor, Aider, Claude Code, custom SDKs) can use deepthink-js as a drop-in backend.
- **Real SSE streaming** — the final synthesis call streams token-by-token through the pipeline's `onChunk` hook, framed as standard OpenAI chunks (`data: {...}` + `data: [DONE]`, usage chunk on `stream_options.include_usage`) or Anthropic events (`message_start` → `content_block_delta` → `message_stop`). 15s keep-alive comments keep long MCTS searches alive through proxies.
- **Thinking traces** — `x-deepthink-trace: true` returns the internal reasoning as `reasoning_content` (OpenAI) or a `thinking` block (Anthropic), with the full call trace under `_deepthink.trace`; every response carries `x-deepthink-trace-id` / `x-deepthink-calls` / `x-deepthink-ms` headers.
- **Per-request deepthink knobs** — `deepthink` object in the request body or `x-deepthink-*` headers control depth (0–3), checks (0–5), output type, code execution, and engine model.
- **MCP server** (`src/mcp.js`, `npm run mcp`) — `@modelcontextprotocol/sdk` server exposing the `deepthink_reason` tool (prompt/type/depth/enableCode). Runs over stdio (Claude Desktop, Cursor) or streamable HTTP at `/mcp` on the proxy (session-based, GET/POST/DELETE).
- **Smoke tests** — `tests/test_proxy.js` (23 checks: models, non-streaming, SSE streaming, Anthropic, traces, errors, /mcp lifecycle) and `tests/test_mcp.js` (10 checks: stdio JSON-RPC initialize/tools/list/tools/call). Auto-discovered by `tests/runAll.js`.

### Changed
- New dependencies: `@modelcontextprotocol/sdk` ^1.30.0, `fastify` ^5.11.3.

## v1.5.0

### Added
- **Parallel-probe thinking** (`thinking/think.ts`): N independent probes fire at the same problem with an identical system+user prefix (KV prefix cache shared — one prompt-eval), then one synthesis call recombines them. Depth 1 = 2 probes, depth 2 = 4, depth 3 = 5. No sequential chain, no KV invalidation per step.
- **`checkStyle: 'blind'`** — checkers see ONLY the claimed answer and must re-derive it (verifier-blind audit). `'full'` (default) audits the whole draft.
- **`answerFormat: 'bracket'`** — the final answer must land as `[value]` on the last line so extractors find it unambiguously (benchmarks, JSON consumers).
- **Check-loop escapes** — the revision loop stops early instead of burning tokens on: repeated verdict patterns (no convergence), stalled pass-counts across 3 revisions, and metacognitive feedback/response churn.
- **Sandbox validation semantics** — a code result is stamped *verified* only when independent implementations agree (MCTS consensus ≥3 votes across ≥2 domains, or JS ≡ Python). Single implementations are *candidates* the checkers may overturn. Ground-truth checkers are only activated for verified values.
- **Benchmark harness** (`scripts/benchmarks/`): `all.js` (AIME 2024-I/II/2023-I, USAMO 2024, IMO 2024, Integration Bee, MBPP, Coding; CSV-resume safe, quote-aware parse), `checkModes.js` (full/blind/zero self-correction experiment), `verify.js` (sympy-backed exact comparison with prose-number fallback), `compare.js` (old-vs-new pipeline comparison).
- **MBPP code-gen plan** — the harness now runs 5 MBPP problems where the model writes a Python function and correctness is verified by executing hidden assert tests in the python sandbox. The prompt names the required function (the tests' calling contract — not an answer leak); a casing-mismatch fallback re-points the tests at the model's def name before failing.

### Changed
- `runThink` synthesis pass no longer capped at 300 tokens by the probe defaults (num_predict merge is caller-last; 600 works).
- AIME benchmark data rebuilt — every data file had alphanumeric characters tripled ("999-kilometer" = real "9-kilometer"); gold answers were for the real problems. Rebuilt 2024-I/II from clean sources, 2023-I from MathArena. All results on those sets are now valid.

### Fixed
- Sandbox ground-truth stamping: `generateAndRunCode` unconditionally returned `sandboxValidated: true`, forcing wrong sandbox values down the whole pipeline (identical wrong answers across all check modes). Now validated only on cross-implementation agreement.
- Code branches no longer rebuild `finalMessages`, which dropped the user's systemPrompt, multi-turn messages, and images.
- Benchmark `withTimeout` race timers now cleared — completed runs no longer hang up to 15 minutes after finishing.
- Benchmark resumed-row aggregates used naive `split(',')` — model answers with commas shifted the columns and the final table under-reported resumed plans. Now quote-aware (matches `compare.js`), and resumed rows also contribute calls/tokens/self-corrections to the table.
- Coding-skip path now loads the cached `coding/critique.json`, so re-runs keep the real critique scores in the table.
- `verify.js` "Final answer:" extraction anchored to line starts so the pipeline's `**Verified Answer: N**` append can't false-match; sympy parse failures retry with the last numeric token (incl. fractions) from prose.

## v1.4.0

### Added
- TypeScript source. `.ts` everywhere, build output in `dist/`. `index.d.ts` exposes the full public surface.
- `Deepthink` extends `node:events.EventEmitter`. `dt.on('log', …)` and `dt.on('step', …)` for pipeline events. Default silent — the old `console.log` with ANSI colors is gone.
- Module-level emitter (`thinking/events.ts`) + `globalEmitter` export. `onLog(fn)` subscribes. `Deepthink` bridges module-level events onto its own emitter so a single `dt.on('log', …)` catches everything.
- `isolated-vm` for the JS sandbox. 32 MB memory cap, 5 s hard timeout, 1 s heap-watch. `require` is blocked outright in the jail — no host modules cross the boundary. `[unserializable]` returned for non-cloneable values.
- Zod-based LLM JSON parsing. `parseJsonSafe(text, schema)` returns `{ ok: true, data } | { ok: false, error, raw }`. `tryParseJsonSafe` is the `T | null` shortcut. Schemas in `parse/llmSchemas.ts`.
- `codeGenerator` split into 6 files (`codeGenerator/{index,sandbox,fileBlocks,python,run,project}.ts`). Public API unchanged.

### Changed
- `runJSSandbox` no longer spawns a subprocess — it runs in-process inside an isolated-vm isolate. Trailing newline stripped from output.
- `extractFromUrl` extractor set trimmed to 13 formats (the 20+ claim was overstated).
- `tsc` now writes to `dist/`. `package.json` `main` / `types` / `exports` point at `dist/`.

### Fixed
- `keyFor` and `findRelevant` in `thinking/reflexion.ts` are now exported.
- `numericScore` re-exported from `thinking/evolvedScoring.ts`.
- `compareResults` reachable from `codeGenerator/index.ts`.
- `runJSSandbox` heap-watch no longer throws on a disposed isolate.
- `parseJsonSafe` returns a real `Error` (or `ZodError`) for parse/validation failures — no more `null` cast that crashed on `.error.issues`.
- Sandbox host-escape: `require` no longer exposes host modules inside the jail. Blocklist-by-name was bypassable through the prototype chain.

### Removed
- `thinking/codeGenerator.js` — moved into the new `codeGenerator/` directory.
- Direct `console.log` with ANSI codes from `Deepthink` class internals. Use the EventEmitter.
- `BLOCKED` set in `sandbox.ts` — replaced with the simpler "block all require" rule.

### Notes
- Python sandbox is best-effort. The subprocess + import blocklist covers the obvious exfil vectors; if you let untrusted code touch `runPythonSandbox` you've already lost.
- `tsc` emits to `dist/`. Tests import from `dist/`. To publish, run `npm run build` then `npm publish`.
