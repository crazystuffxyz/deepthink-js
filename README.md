# Deepthink

**An AI reasoning engine with multi-step thinking, sandboxed code execution, deep web research, autonomous browser control, self-verifying answer loops, persona debate, self-consistency voting, plan-and-execute, tool use, reflexion, mixture-of-agents, and confidence calibration. Works with Ollama, OpenAI, Claude, Gemini, Perplexity, Grok, and LM Studio.**

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Multi-Provider Setup](#multi-provider-setup)
- [Core API — `Deepthink` Class](#core-api--deepthink-class)
  - [Constructor](#constructor)
  - [`callChat()`](#callchat)
  - [`generate()`](#generate)
  - [New Reasoning Modes](#new-reasoning-modes)
  - [`generateAndRunProject()` (via codeGenerator)](#generateandrunproject-via-codegenerator)
- [Research Agent](#research-agent)
- [Internet Utilities](#internet-utilities)
- [Electron Free Explorer](#electron-free-explorer)
- [Testing](#testing)
- [Advanced Options Reference](#advanced-options-reference)
- [Internal Architecture](#internal-architecture)
- [Project Structure](#project-structure)
- [Requirements & Dependencies](#requirements--dependencies)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [License](#license)

---

## Overview

Deepthink wraps any LLM provider with a stack of reasoning infrastructure:

- **Multi-provider support** — Ollama, OpenAI, Claude (Anthropic), Gemini (Google), Perplexity, Grok (xAI), LM Studio, or any OpenAI-compatible endpoint
- **Multi-depth thinking** — up to 3 staged internal reasoning passes (analysis → planning → sanity check) before the final response
- **Typed output parsing** — returns `string`, `integer`, `double`, or `boolean` directly from free-form model output
- **Self-verification loops** — adversarial and numerical checker agents review responses and drive iterative repair
- **Sandboxed code execution** — generates and runs JavaScript (Node.js) and Python code in isolated subprocesses to verify numeric answers
- **MCTS consensus** — runs multiple algorithmic approaches in parallel and votes on the most consistent result
- **9-step deep research pipeline** — query planning → crawling → credibility scoring → MMR diversity → fact verification → report writing → critique loops
- **Universal URL-to-HTML extractor** — fetches and converts HTML, PDF, DOCX, XLSX, PPTX, EPUB, CSV, RTF, ODT, JSON, XML, Markdown, images, and SVG
- **Chrome TLS fingerprint spoofing** — `impit`-backed axios adapter that bypasses bot-detection
- **Autonomous Electron browser** — a free-roaming AI agent that browses the web with human-like mouse events, multi-tab management, and reflective session summaries
- **AI code project generator** — cognitive planning → code generation → AST validation → sandbox execution → test oracle → iterative repair
- **Self-consistency voting** — sample N candidates in parallel, return the majority
- **Persona debate** — two opposing agents argue, an impartial judge picks the stronger side
- **Plan-and-execute** — explicitly plan atomic steps, run each, reflect, then synthesize
- **Reflexion** — after a failure, write a one-sentence lesson; recall similar lessons before the next attempt
- **Mixture-of-agents** — fan out to N providers, judge merges the strongest elements
- **Tool use** — model emits JSON tool calls; the engine runs `js_eval` / `py_eval` / custom tools in a sandbox, loops until `finish`
- **Smart context compression** — when token budget overflows, summarize the middle, keep the head and tail
- **Persistent memory** — JSON-file-backed store at `~/.deepthink-js/memory.json` for cross-session state
- **Confidence calibration** — track per-type wins/losses; blend with a 0.5 prior at low N

---

## Installation

Install `deepthink-js` from npm — all dependencies are bundled automatically:

```bash
npm install deepthink-js
```

For the Electron explorer example only:

```bash
npm install electron pdf-parse
```

For Python sandbox support (optional but recommended for numeric verification):

```bash
pip install sympy
```

> **Node.js ≥ 18** is required. The package uses ES Modules — set `"type": "module"` in your `package.json`.

---

## Quick Start

```js
import Deepthink from 'deepthink-js';

// Ollama (default — no API key needed)
const dt = new Deepthink('cogito-2.1:671b-cloud');

// 1. Simple string generation
const answer = await dt.generate('What is the capital of France?');
console.log(answer); // "Paris"

// 2. Typed integer output with 2-stage thinking and 2 verification checks
const count = await dt.generate(
  'How many prime numbers are less than 50?',
  { type: 'integer', depth: 2, checks: 2 }
);
console.log(count); // 15

// 3. Streaming response for long-form content
await dt.generate(
  'Explain the Riemann Hypothesis in plain language.',
  {
    depth: 1,
    onChunk: (chunk, meta) => process.stdout.write(chunk)
  }
);

// 4. Full Project Generation (AI App Builder)
import { generateAndRunProject } from 'deepthink-js/thinking/codeGenerator.js';
const callChat = dt.callChat.bind(dt);
const project = await generateAndRunProject(callChat, 'Build a personal finance dashboard with chart.js');
console.log('Project created with', Object.keys(project.files).length, 'files');
```

---

## Multi-Provider Setup

Pass `clientOptions.provider` to the constructor to route calls to any supported backend.

### OpenAI
```js
const dt = new Deepthink('gpt-4o', [process.env.OPENAI_API_KEY], { provider: 'openai' });
```

### Anthropic Claude
```js
const dt = new Deepthink('claude-opus-4-6', [process.env.ANTHROPIC_API_KEY], { provider: 'claude' });
```

### Google Gemini
```js
const dt = new Deepthink('gemini-2.5-flash', [process.env.GEMINI_API_KEY], { provider: 'gemini' });
```

### Perplexity
```js
const dt = new Deepthink('sonar-pro', [process.env.PERPLEXITY_API_KEY], { provider: 'perplexity' });
```

### Grok (xAI)
```js
const dt = new Deepthink('grok-3', [process.env.XAI_API_KEY], { provider: 'grok' });
```

### LM Studio (local)
```js
const dt = new Deepthink('my-local-model', [], { provider: 'lmstudio' });
```

### Any OpenAI-Compatible Endpoint
```js
const dt = new Deepthink('my-model', ['my-api-key'], {
  provider: 'openai-compat',
  baseUrl: 'https://my-custom-server.example.com/v1',
});
```

---

## Core API — `Deepthink` Class

### Constructor

```js
new Deepthink(model, apiKeys, clientOptions, concurrency, auditModel)
```

| Parameter       | Type       | Default                 | Description |
|-----------------|------------|-------------------------|-------------|
| `model`         | `string`   | `process.env.OLLAMA_MODEL \|\| 'llama3.1'` | Primary model identifier |
| `apiKeys`       | `string[]` | `[]`                    | API keys for the selected provider, rotated automatically on failure and quarantined for 60 s after 2 consecutive errors |
| `clientOptions` | `object`   | `{}`                    | Provider configuration — see `clientOptions` table below |
| `concurrency`   | `number`   | `Infinity`              | Maximum simultaneous in-flight requests |
| `auditModel`    | `string`   | same as `model`         | Model used for verification checker agents |

**`clientOptions` fields:**

| Field        | Description |
|--------------|-------------|
| `provider`   | One of: `ollama` (default), `openai`, `claude`, `gemini`, `perplexity`, `grok`, `lmstudio`, `openai-compat` |
| `baseUrl`    | Override the base URL for the selected provider |
| `host`       | Alias for `baseUrl` |
| `apiKey`     | Inline API key (alternative to passing via constructor `apiKeys` array) |
| `headers`    | Extra HTTP headers merged into every request |
| `anthropicVersion` | Anthropic API version header (default: `2023-06-01`) |

**Environment variables (fallback when no key is passed):**

| Variable              | Used by provider |
|-----------------------|-----------------|
| `OLLAMA_HOST`         | Ollama |
| `OLLAMA_API_KEY`      | Ollama |
| `OLLAMA_MODEL`        | Ollama |
| `OPENAI_API_KEY`      | OpenAI |
| `ANTHROPIC_API_KEY`   | Claude |
| `GEMINI_API_KEY`      | Gemini |
| `PERPLEXITY_API_KEY`  | Perplexity |
| `XAI_API_KEY`         | Grok |

---

### `callChat()`

Low-level chat method with automatic retry, streaming fallback, and API key rotation.

```js
const result = await dt.callChat(messages, stream, onChunk, opts);
// result: { content: string, thinking: string }
```

| Parameter  | Type       | Description |
|------------|------------|-------------|
| `messages` | `Message[]`| OpenAI-style `[{ role, content }]` array |
| `stream`   | `boolean`  | Enable streaming |
| `onChunk`  | `function` | `(chunk, { kind: 'content' \| 'thinking' }) => void` |
| `opts`     | `object`   | See [options reference](#generate-options) |

Retries up to 3 times with exponential backoff (500 ms → 1 s → 2 s).

---

### `generate()`

High-level generation with named parameters, multi-stage thinking, code sandboxing, and self-verification.

```js
const result = await dt.generate(input, opts);
```

| Parameter  | Type                                                     | Description |
|------------|----------------------------------------------------------|-------------|
| `input`    | `string \| Message[] \| object`                          | The prompt — plain string, messages array, or any object |
| `opts`     | `object`                                                 | Named options — see full table below |

All options are passed as a single named object. This makes call sites self-documenting:

```js
// Simple call — all defaults
await dt.generate('What is pi?');

// Fully configured call
await dt.generate('Count the prime numbers below 1000', {
  type:    'integer',
  depth:   2,
  checks:  2,
  model:   'gpt-4o',          // override for this call only
  onChunk: chunk => process.stdout.write(chunk),
});

// Streaming creative writing
await dt.generate('Write a short story about a robot.', {
  depth:   1,
  onChunk: (chunk, meta) => process.stdout.write(chunk),
  options: { temperature: 0.9 },
});

// Research-style deep thinking with analytical decomposition
const answer = await dt.generate('What are all distinct ways to tile a 2×8 board with 1×2 dominoes?', {
  type:       'integer',
  depth:      3,
  checks:     3,
  analytical: true,
});
```

**`generate()` options object:**

| Option                   | Type       | Default     | Description |
|--------------------------|------------|-------------|-------------|
| `type`                   | `string`   | `'string'`  | Return type: `'string'`, `'integer'`, `'double'`, `'boolean'` |
| `depth`                  | `0–3`      | `1`         | Internal thinking stages before final answer |
| `checks`                 | `number`   | `0`         | Verification checker passes (max 3) |
| `onChunk`                | `function` | `null`      | Streaming callback `(chunk, meta) => void` |
| `model`                  | `string`   | constructor model | Override model for this call |
| `systemPrompt`           | `string`   | auto        | Custom system prompt |
| `autoSystemPrompt`       | `boolean`  | `true`      | Inject a default system prompt |
| `think`                  | `boolean`  | `false`     | Enable model's native `<think>` token |
| `enableCode`             | `boolean`  | `true`      | Auto-detect and run sandboxed code |
| `mcts`                   | `boolean`  | `true`      | Enable MCTS multi-approach consensus |
| `mctsNumApproaches`      | `number`   | `4`         | Algorithmic approaches for MCTS |
| `mctsConsensusThreshold` | `number`   | `3`         | Minimum agreement count for HIGH confidence |
| `analytical`             | `boolean`  | `false`     | Multi-agent analytical decomposition mode |
| `humanBrain`             | `boolean`  | `false`     | Attach a `BrainMemory` (working + semantic) |
| `maxCheckIterations`     | `number`   | `10`        | Max self-verification repair iterations |
| `monitorWindowSize`      | `number`   | `5`         | MetacognitiveMonitor response history window |
| `images`                 | `string[]` | `[]`        | Base64 image strings for multimodal input |
| `options`                | `object`   | `{}`        | Raw provider sampling params (temperature, top_p, etc.) |
| `_globalBudget`          | `object`   | none        | `{ maxLLMCalls: number }` — hard cap on total LLM calls |
| `ollamaOutput`           | `boolean`  | `false`     | Return raw `<think>` blocks in output (Ollama only) |

**Depth levels:**

| Depth | Stages |
|-------|--------|
| `0`   | Direct answer — no pre-thinking |
| `1`   | Analysis pass |
| `2`   | Analysis → Planning |
| `3`   | Analysis → Planning → Sanity Check |

---

### New Reasoning Modes

Additive — pass any of these as options to `dt.generate(input, opts)`. They do not change the existing options; they just route to a different reasoning module before the main flow.

```js
// Self-consistency: sample N candidates, return the majority
const r = await dt.generate('What is 6 * 7?', {
  type: 'integer',
  selfConsistency: true,
  selfConsistencySamples: 5,
});

// Persona debate: two agents argue, judge picks the stronger side
const r = await dt.generate('Is intermittent fasting healthier than 3 meals a day?', {
  debate: true,
  debateRounds: 2,
});

// Plan-and-execute: explicit plan, run each step, reflect, synthesize
const r = await dt.generate('List the first 5 prime numbers.', {
  planExecute: true,
});

// Tool use: model emits JSON tool calls, engine runs them, loops until 'finish'
const r = await dt.generate('Compute 11 * 11, then call finish with the answer.', {
  tools: true,           // or pass an array of custom tools
  maxSteps: 4,
});

// Reflexion: recall past lessons, then write a new lesson on failure
const r = await dt.generate('What is 17 * 19?', {
  type: 'integer',
  reflexion: true,
  // _lastResultFailed: 'wrong answer'  // pass this to trigger a lesson write
});

// Mixture-of-agents: fan out to N providers, judge merges
const r = await dt.generate('Summarize the causes of WWI in 50 words.', {
  mixtureModels: ['gemma4:31b-cloud', 'gemma4:31b-cloud'],
  // each entry can also be { name, callChat } for cross-provider routing
});

// Confidence calibration: track wins/losses per task type
const r = await dt.generate('2 + 2 = ?', { type: 'integer', calibrate: true });
// dt._calibrator (private) holds the running stats; expose via your own getter

// Evolved thinking: synthetic-RL prompt evolution. generates N candidate prompt templates,
// scores each on a 10-item benchmark, mutates the best, repeats. applies the winner to your input.
const r = await dt.generate('Explain the Banach-Tarski paradox in plain English.', {
  evolve: true,
  evolvePop: 10,            // candidates per generation
  evolveGenerations: 6,     // how many rounds of mutation
  // evolveOnly: true,     // just run evolution, skip the apply step
});
```

### Evolved Thinking (prompt evolution)

The evolve mode is built on three ideas pulled from real reasoning research:

1. **Patterns from geniuses** — the `thinkingPatterns.js` library contains 25+ citable thinking moves, each tied to a named thinker (Feynman, Erdős, Ramanujan, Poincaré, Tao, Knuth, Sagan, Curie, Turing, McClintock, Lamarr, Kahneman, von Neumann, Dijkstra, Lovelace, Fuller, ...). Every move is one concrete instruction the LLM can follow.
2. **Synthetic-RL evolution** — a population of 10 prompt-template candidates is generated by composing these patterns, scored against a fixed 10-item benchmark (math, logic, code, science, paradox, planning, hypothesis, ethics, deduction), mutated via 12 operators (add-reconsider, add-feynman-elaborate, add-counter-example, add-verification, add-devils-advocate, add-numerical-sanity, add-analogy, add-parallel-drafts, add-lemma-decompose, add-incubation, change-tone-socratic, compress-to-half), and selected by tournament. The loop runs for N generations. The full per-generation log is written to `data/evolved/<runId>/population-gen-NNN.json` so you can see what each generation found.
3. **Generalization** — the winning template is a *composition* of moves from different thinkers, which means it generalizes across task types (no overfit to one benchmark item).

```js
import { evolvePrompts, applyEvolvedPrompt, loadBest, PATTERNS, BENCH, OOD_BENCH } from 'deepthink-js';

// run evolution with the OOD probe — the loop trains on BENCH, then scores
// the winner on the held-out OOD_BENCH and reports the gap.
const result = await evolvePrompts(callChat, {
  popSize: 10,
  generations: 8,
  bench: BENCH,
  oodBench: OOD_BENCH,
});
console.log('best:', result.best.id, 'fitness:', result.best.fitness);
if (result.oodScore != null) {
  const gap = (result.best.fitness || 0) - result.oodScore;
  console.log(`OOD: ${result.oodScore.toFixed(3)}  gap: ${gap.toFixed(3)}${gap > 0.20 ? '  ⚠ overfit' : '  ✓ generalizes'}`);
}
console.log('log at:', result.runDir);

// apply the winning template to a new hard problem
const answer = await applyEvolvedPrompt(callChat, result.best.systemPrompt,
  'Design a fair consensus protocol for 3 mutually distrustful parties with no trusted dealer.');

// or re-use a previous run
const best = loadBest('./data/evolved/2026-07-08-...');
const answer2 = await applyEvolvedPrompt(callChat, best.systemPrompt, '...');
```

CLI:

```bash
node scripts/evolve.js 10 6        # 10 candidates, 6 generations
node scripts/applyBest.js <runId> "your hard problem"
```

The seed population includes a `fableMetaPrompt` variant that forces a visible `<thinking>` block, a 4-stage classify → restate → attack → verify workflow, and explicit "actually…" / "wait…" self-correction markers — modeled on the thinking format used by the strongest public reasoning models. Scoring rewards candidates that actually produce visible reasoning, so the loop converges on prompts that elicit thinking, not just on prompts that produce lucky answers. Operators include `fableThinkFormat`, `fableClassify`, `fableInternalCritic`, `fableCalibrate`, and `fableHighIntensity` to push the population toward the Fable-style format.

All new modes respect the existing `type`, `depth`, `checks`, `onChunk`, and `model` options. They short-circuit before the main flow and never call the legacy paths unless you set the option to `false`.

### OOD Probe (generalization check)

Once an evolution run finishes, run two probes to make sure the winning template actually generalizes instead of having overfit the in-distribution benchmark:

```bash
# 1. score the winner on a held-out OOD benchmark (5 fresh problems, never seen by the loop)
node scripts/probeOOD.js <runId>
# writes data/evolved/<runId>/ood-score.json with {idFitness, oodFitness, gap}
# gap > 0.20 means the winner overfit — re-evolve with a wider benchmark

# 2. apply the winner to 3 hand-picked "hard hard problems" (consensus protocol, dedupe, hypothesis)
node scripts/probeGeneralize.js <runId>
# prints the winner's full <thinking>...</thinking> + answer trace
```

The OOD probe uses 5 held-out items (`ood-01-fair-share`, `ood-02-subset-sum`, `ood-03-monty-extended`, `ood-04-anagram-check`, `ood-05-orbit`) that the evolution loop never sees. If the in-distribution score is high but the OOD score is much lower, the prompt is gaming the bench — discard it and re-run with a wider `BENCH` distribution or fewer generations.

**Interpreting the gap:** in practice on `gemma4:31b-cloud`, the in-distribution BENCH runs at ~0.7 while the OOD bench runs at ~0.3. That gap is mostly *bench hardness* (the OOD items include multi-number and algorithmic problems that even strong models get wrong) rather than prompt overfit. The real signal is `probeGeneralize` — if the winner still produces a coherent, structured answer on the 3 hand-picked hard problems, the prompt has generalized even if its numeric OOD score is low.

---

### `generateAndRunProject()` (via codeGenerator)

Generates a complete, runnable multi-file project from a task description.

```js
import Deepthink from 'deepthink-js';
import { generateAndRunProject } from 'deepthink-js/thinking/codeGenerator.js';

const dt = new Deepthink('cogito-2.1:671b-cloud');
const callChat = dt.callChat.bind(dt);

const result = await generateAndRunProject(callChat, 'Build a CLI tool that converts CSV to JSON', {
  thinkingDepth:   2,
  maxProjectLoops: 6,
  maxOracleLoops:  3,
});

if (result.success) {
  console.log(result.files);        // { 'index.js': '...', ... }
  console.log(result.buildCommands);
  console.log(result.runCommands);
}
```

---

## Research Agent

The `researchAgent` implements a high-fidelity, 9-step verification pipeline that transforms a simple query into a peer-reviewed academic report.

```js
import Deepthink from 'deepthink-js';
import runDeepResearch from 'deepthink-js/thinking/researchAgent.js';

const dt = new Deepthink('cogito-2.1:671b-cloud', []);
const callChat = dt.callChat.bind(dt);

const result = await runDeepResearch(
  callChat,
  'What are the causes of the 2008 financial crisis?',
  {
    maxQueries:           12,
    maxConcurrency:       10,
    credibilityThreshold: 45,
    maxSummaries:         20,
    useOllamaSearch:      true,
    academicFilter:       false,
  }
);

console.log(result.report);      // Full markdown research report
console.log(result.references);  // Array of APA-formatted citations
console.log(result.claimCount);  // Number of verified facts
console.log(result.success);     // boolean
```

**Pipeline steps:**

| Step | Name | Description |
|------|------|-------------|
| 0 | Answer Format Detection | Classifies what a correct answer looks like |
| 1 | Query Planning | Generates layered search queries at up to 3 recursion depths |
| 2 | Parallel Web Crawling | Fetches all URLs concurrently via `extractArticleText` |
| 3 | Credibility Scoring | Scores each source (0–100) |
| 4 | MMR Diversity Filter | Maximal Marginal Relevance selects a diverse, high-credibility subset |
| 5 | Fact Verification Loop | Each extracted claim is verified against its source |
| 6 | Report Writing | Synthesises verified claims into a structured markdown report |
| 7–9 | Critique & Repair Loop | Domain expert, adversarial, source fidelity, and math/logic critic agents |

---

## Internet Utilities

### Universal Content Extractor

```js
import { extractArticleText } from 'deepthink-js/internet/extractFromUrl.js';

const html = await extractArticleText('https://example.com/paper.pdf');
```

Supports HTML, PDF, DOCX, XLSX, PPTX, EPUB, CSV, TSV, JSON, XML, Markdown, plain text, RTF, ODT, SVG, and images.

---

### Chrome-Fingerprinted Axios Adapter

```js
import axios from 'deepthink-js/internet/axios.js';

const response = await axios.get('https://example.com', {
  responseType: 'arraybuffer',
  timeout: 15000,
});
```

Uses `impit` to mimic Chrome's TLS fingerprint, bypassing most bot-detection middleware.

---

### Ollama Web Search

```js
import { getOllamaSearchResults } from 'deepthink-js/internet/ollamaSearch.js';

const results = await getOllamaSearchResults('Riemann hypothesis latest research', 5);
// results: [{ title, link, snippet, cite }, ...]
```

---

## Electron Free Explorer

An autonomous AI browsing agent that explores the web with human-like behaviour.

```bash
npm install electron pdf-parse && npx electron examples/electron_explorer.js
```

Press `Ctrl+C` to stop — a reflective journal-style session summary is generated and saved to disk.

**Features:**

- Up to 3 concurrent browser tabs; least-productive tabs pruned automatically
- Human-like mouse movement, clicking, triple-click-and-type, scroll, and key press simulation
- PDF detection — automatically fetches and injects text as readable HTML
- Goal compression every 20 loops — the AI builds and evolves a first-person "current focus" narrative
- Topic drift detection — nudges the AI toward new territory after 8+ loops on the same hostname
- Full action log written to `log.txt`; session summaries saved as `summary_<timestamp>.txt`

---

## Testing

```bash
npm test           # full suite (pure + integration against your configured model)
npm run test:fast  # pure tests only (no LLM)
```

Tests default to `gemma4:31b-cloud`. Override with `DEEPTHINK_TEST_MODEL=... npm test`. Each test file exits 0 on pass, 1 on fail. The runner prints a summary at the end.

| Test file | Coverage | LLM? |
|---|---|---|
| `test_dataTypes.js` | stripThinkBlocks, stripCodeFences, parseDataType, messages, normalization | no |
| `test_memory.js` | persistent + ephemeral memory stores | no |
| `test_compression.js` | token counting, middle-truncation, compress passthrough | no |
| `test_consistency.js` | vote, keyFor, findRelevant, makeCalibrator | no |
| `test_toolUse.js` | parseToolCall, describeTools | no |
| `test_providers.js` | client construction across all 8 providers | no |
| `test_sandbox.js` | JS sandbox, Python sandbox, compareResults | no (Python needs `python3` in PATH) |
| `test_integration.js` | every new public option against the configured model | yes |

---

## Advanced Options Reference

### `generate()` Options

See the [full options table](#generate-options) in the `generate()` section above.

---

### `researchAgent` Options

| Option                   | Type       | Default | Description |
|--------------------------|------------|---------|-------------|
| `maxQueries`             | `number`   | `12`    | Total search queries to plan |
| `maxConcurrency`         | `number`   | `10`    | Parallel URL fetch workers |
| `credibilityThreshold`   | `number`   | `45`    | Minimum score (0–100) to include a source |
| `maxSummaries`           | `number`   | `20`    | Max sources after MMR diversity filter |
| `diversityLambda`        | `number`   | `0.6`   | MMR trade-off: 1.0 = pure relevance, 0.0 = pure diversity |
| `chunkSize`              | `number`   | `20`    | Claims per report-writing chunk |
| `useOllamaSearch`        | `boolean`  | `false` | Use Ollama web search. Falls back to SearXNG when `false` |
| `academicFilter`         | `boolean`  | `false` | Restrict sources to trusted academic/news domains |
| `academicWhitelist`      | `string[]` | built-in| Additional trusted domains |
| `academicBlacklist`      | `string[]` | built-in| Additional domains to block |
| `academicWhitelistMode`  | `'extend' \| 'replace'` | `'extend'` | Whitelist merge mode |
| `academicBlacklistMode`  | `'extend' \| 'replace'` | `'extend'` | Blacklist merge mode |
| `credNegativePatterns`   | `RegExp[]` | built-in| URL patterns that reduce credibility |
| `enableCritique`         | `boolean`  | `true`  | Run critique-and-repair loop (steps 7–9) |
| `recursionDepth`         | `number`   | `2`     | Query tree depth |

---

## Internal Architecture

```
Deepthink.generate()
│
├── runThink()                    ← Multi-stage pre-thinking (think.js)
│   ├── depth ≥ 1 → Analysis pass
│   ├── depth ≥ 2 → Planning pass
│   └── depth ≥ 3 → Sanity-check pass
│
├── detectComputeNeeds()          ← Decide: none / single / parallel
│
├── generateAndRunCode()          ← codeGenerator.js
│   ├── runMCTSApproaches()       ← 4 parallel Python sandboxes, consensus vote
│   ├── mathematicianAgent()      ← Formal spec (no code)
│   ├── engineerAgent() × 2      ← JS + Python implementations
│   ├── runJSSandbox()
│   ├── runPythonSandbox()
│   └── reconcileResults()
│
├── callChat()                    ← Final answer with ground truth injected
│   └── buildProviderClient()     ← Routes to correct provider adapter
│
└── runChecks() × N              ← Self-verification loop
    ├── Standard checker
    ├── Adversarial checker
    └── Numerical checker
        └── MetacognitiveMonitor
```

```
runDeepResearch()
│
├── Step 0  detectAnswerFormat()
├── Step 1  plannerAgent()
├── Step 2  crawlerAgent()
├── Step 3  verificationAgent()
├── Step 4  extractWithFallback() + applyMMR()
├── Step 5  factVerificationLoop()
├── Step 6  reportWriterAgent()
└── Steps 7–9  critiqueAndRepairLoop()
```

---

## Project Structure

```
thinking/
├── deepthink.js          Main Deepthink class (generate, callChat, verification)
├── researchAgent.js      9-step deep research pipeline
├── codeGenerator.js      Project generation, MCTS, sandboxes, test oracle
├── analytical.js         Multi-agent analytical decomposition mode
├── think.js              Multi-stage pre-thinking passes
├── dataTypes.js          Type parsing, message normalisation utilities
├── cognitive.js          7-phase cognitive flow
├── consistency.js        Self-consistency: sample N, vote
├── personaDebate.js      Two-agent debate + judge
├── planAndExecute.js     Explicit plan, run steps, reflect, synthesize
├── reflexion.js          Lesson store + writeLesson + recall
├── smartCompression.js   Compress when token budget overflows
├── toolUse.js            Tool-call loop (js_eval, py_eval, finish, custom)
├── mixtureOfAgents.js    Fan out to N providers, judge merges
├── confidence.js         Per-type win/loss calibration
└── memory.js             JSON-file-backed persistent store

providers/
└── index.js              Multi-provider adapter (OpenAI, Claude, Gemini, Perplexity, Grok, LM Studio, Ollama)

internet/
├── extractFromUrl.js     Universal URL → HTML extractor (20+ formats)
├── axios.js              Chrome TLS-spoofing axios adapter (impit)
├── ollamaSearch.js       Ollama web search (REST + JS client fallback)
├── interactWithInternet.js Search + fetch orchestration layer
└── extractCitation.js    APA citation generator

examples/
├── electron_explorer.js  Autonomous AI browser agent (Electron)
└── research.js           Standalone deep research usage example
```

---

## Requirements & Dependencies

Install via `npm install deepthink-js` — everything below is included automatically.

| Dependency | Purpose |
|---|---|
| `ollama` | Ollama JS client |
| `axios` | HTTP client (wrapped by the impit adapter) |
| `impit` | Chrome TLS fingerprint for bot bypass |
| `cheerio` | HTML parsing and cleaning |
| `jsdom` | DOM for Readability |
| `@mozilla/readability` | Article extraction from HTML |
| `mammoth` | DOCX → HTML conversion |
| `xlsx` | Spreadsheet (XLSX/XLS/ODS) parsing |
| `jszip` | PPTX, ODT, EPUB unpacking |
| `fast-xml-parser` | XML/PPTX slide text extraction |
| `@iarna/rtf-to-html` | RTF → HTML |
| `papaparse` | CSV/TSV parsing |
| `marked` | Markdown → HTML |
| `pdf-parse` | PDF text extraction |
| `electron` | (examples/electron_explorer.js only — install separately) |
| `python3` + `sympy` | Python sandbox and symbolic math (optional — install separately) |

Node.js ≥ 18 is required for native `fetch`, `ReadableStream`, and top-level `await`.

---

## Troubleshooting

### ❌ Python Sandbox Errors
If you see "Python not installed", ensure `python3` is in your system PATH. For complex math, `pip install sympy` is highly recommended.

### ❌ API Key Rotation Failures
Deepthink rotates keys automatically. If all keys in an array fail, the engine will throw a terminal error. Check your `.env` or constructor `apiKeys` array.

### ❌ Gemini Cookie Authentication
Gemini Web requires specific cookies (`__Secure-1PSID`, `__Secure-1PSIDTS`). If authentication fails, ensure you are logged in via a Chromium-based browser and that your cookies haven't expired.

### ❌ Memory/OOM in Code Generation
For extremely large projects, the LLM may time out or hit context limits. Try breaking the task into smaller, more specific requests or increasing the `thinkingDepth`.

---

## Contributing

We welcome contributions to make Deepthink more powerful.

### Adding a New Provider
1. Create a new file in `providers/` (e.g., `providers/mistral.js`).
2. Implement the `callChat` adapter to map Deepthink's message format to the provider's API.
3. Register the provider in `providers/index.js`.

### Improving Agents
Modify files in the `thinking/` directory. Most agents follow a pattern of `Analysis → Execution → Verification`. When updating prompts, always test with both a "small" (Flash) and "large" (Opus/Pro) model to ensure robust parsing.

---

## Roadmap

- [x] **Multi-Agent Swarms**: Multiple agents per call (mixture-of-agents, persona debate)
- [x] **Long-term Memory**: Persistent JSON store at `~/.deepthink-js/memory.json`
- [x] **Tool Use**: Model emits JSON tool calls, engine runs them in a sandbox
- [x] **Self-Consistency / Plan-and-Execute / Reflexion / Calibration**: New reasoning modes
- [ ] **Visual Verification**: Ability for agents to "see" the generated UI via screenshots and fix layout bugs
- [ ] **Dynamic Tool Synthesis**: Ability for the agent to write and install its own npm packages to solve a specific task
- [ ] **Cross-Session Replay**: Replay an entire reasoning session from a saved log

---

## License

MIT
