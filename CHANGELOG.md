# Changelog

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
