# Changelog

## v1.4.0

### Added
- TypeScript source. `.ts` everywhere, `.js` emitted alongside. `index.d.ts` exposes the full public surface.
- `Deepthink` extends `EventEmitter`. `dt.on('log', …)` and `dt.on('step', …)` for pipeline events. The old `console.log` with ANSI colors is gone; default is silent.
- Module-level emitter (`thinking/events.ts`). `onLog(fn)` subscribes; `makeConsoleLogger(true)` opts into color output.
- `isolated-vm` for the JS sandbox. 32 MB memory cap, 5 s hard timeout, 1 s heap-watch, isolates disposed on dispose. Blocklist: `child_process`, `fs`, `net`, `crypto`, `vm`, `inspector`.
- Zod-based LLM JSON parsing. `parseJsonSafe(text, schema)` returns `{ ok: true, data } | { ok: false, error, raw }`. `tryParseJsonSafe` is the `T | null` shortcut. Schemas in `parse/llmSchemas.ts`.
- `codeGenerator` split into 6 files (`codeGenerator/{index,sandbox,fileBlocks,python,run,project}.ts`). Public API unchanged.

### Changed
- `runJSSandbox` no longer spawns a subprocess — it runs in-process inside an isolated-vm isolate. Trailing newline stripped from output. Returns `[unserializable]` for non-cloneable return values.
- `extractFromUrl` extractor set trimmed to 13 formats (the 20+ claim was overstated).

### Fixed
- `keyFor` and `findRelevant` in `thinking/reflexion.ts` are now exported.
- `numericScore` re-exported from `thinking/evolvedScoring.ts`.
- `compareResults` reachable from `codeGenerator/index.ts`.
- `runJSSandbox` heap-watch no longer throws on a disposed isolate.

### Removed
- `thinking/codeGenerator.js` — moved into the new `codeGenerator/` directory.
- Direct `console.log` with ANSI codes from `Deepthink` class internals. Use the EventEmitter.

### Notes
- Python sandbox is unchanged. The subprocess + import-blocklist approach is best-effort — the obvious exfil vectors are covered, but if you let untrusted code touch `runPythonSandbox` you've already lost.
- `tsc` emits `.js` files next to the `.ts` source. If you commit the `.ts` (recommended), the `.js` is generated and should also be committed so consumers without `tsc` can run the lib.
