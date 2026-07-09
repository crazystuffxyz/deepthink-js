# Changelog

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
