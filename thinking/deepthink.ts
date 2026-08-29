// thinking/deepthink.ts
// @ts-nocheck — large pre-existing surface, runtime-tested, full type coverage deferred.
import { EventEmitter } from 'node:events';
import PQueue from 'p-queue';
import { buildProviderClient } from '../providers/index.js';
import { createDefaultSystemPrompt, messagesToText, normalizeInputToMessages, parseDataType, stripThinkBlocks, extractJSON } from './dataTypes.js';
import { cloneMessage } from './dataTypes.js';
import { runMoA } from './mixtureOfAgents.js';
import { runThink } from './think.js';
import { runDebate } from './personaDebate.js';
import { selfConsistency } from './consistency.js';
import { attachReflexion } from './reflexion.js';
import { makeCalibrator } from './confidence.js';
import { runPlanAndExecute } from './planAndExecute.js';
import { analyzeAndSolve } from './analytical.js';
import { runCognitiveFlow } from './cognitive.js';
import { compress, truncateMiddle } from './smartCompression.js';
import { evolvePrompts, applyEvolvedPrompt, loadBest } from './evolvedThinking.js';
import { toolLoop, DEFAULT_TOOLS } from './toolUse.js';
import { generateAndRunCode } from '../codeGenerator/index.js';
import { PYTHON_BIN } from '../codeGenerator/python.js';
import { compareResults } from '../codeGenerator/run.js';
import { globalEmitter } from './events.js';
import { TraceStore } from './trace.js';
import { AdaptiveConcurrency, isRateLimitError, isTimeoutError } from './concurrency.js';
import { loadImages, describeImages, looksVisionCapable } from './images.js';

const SAMPLING = {
  creative: { temperature: 0.7, top_p: 0.9, top_k: 40 },
  reasoning: { temperature: 0.55, top_p: 0.85, top_k: 25 },
  json: { temperature: 0, top_p: 1, top_k: 1 },
  verify: { temperature: 0.05, top_p: 0.9, top_k: 20 },
  code: { temperature: 0.1, top_p: 0.85, top_k: 20 }
};

const qwen = { temperature: 0.6, top_p: 0.95, top_k: 20 };

const sandbox = '<<<SANDBOX_TRUSTED_OUTPUT>>>\n';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogEvent = { level: LogLevel; msg: string; source: string; ts: number };
type StepEvent = { name: string; meta?: Record<string, unknown> };
type TokenEvent = { delta: string; kind: 'content' | 'thinking' };

type Check = { correct: boolean; feedback: string | null };
type CheckResult = Check;

type ChatMessage = { role: string; content: string; images?: string[]; name?: string };
type ChatParams = { model?: string; messages: ChatMessage[]; stream?: boolean; options?: Record<string, unknown>; think?: boolean | string; format?: string | object; keep_alive?: string; max_tokens?: number; onChunk?: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null; ollamaOutput?: boolean };
type ChatResult = { content: string; thinking?: string; promptTokens?: number | null; responseTokens?: number | null; latencyMs?: number | null };

type ProviderClient = { chat: (p: ChatParams) => Promise<ChatResult> };

type Caller = { name: string; callChat: (msgs: unknown[], stream: boolean, onChunk: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null, opts: Record<string, unknown>) => Promise<{ content: string }> };
type CallChat = (msgs: unknown[], stream: boolean, onChunk: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null, opts: Record<string, unknown>) => Promise<{ content: string }>;
type Context = { callChat: (...a: unknown[]) => Promise<{ content: string }>; generate?: (...a: unknown[]) => Promise<unknown>; limiter?: { run: <T>(fn: () => Promise<T>) => Promise<void | T> } };
type CognitiveOpts = { onChunk?: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void); [k: string]: unknown };

type DeepthinkOptions = {
  model?: string;
  type?: string;
  depth?: number;
  checks?: number;
  checkStyle?: 'full' | 'blind';
  onChunk?: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null;
  mixtureModels?: Array<string | { name: string; callChat?: (...a: unknown[]) => Promise<unknown> }>;
  mixtureJudge?: (...a: unknown[]) => Promise<unknown>;
  evolve?: boolean;
  evolveOnly?: boolean;
  evolvePop?: number;
  evolveGenerations?: number;
  evolveRunId?: string;
  evolvedApply?: string;
  tools?: boolean | object;
  planExecute?: boolean;
  debate?: boolean;
  selfConsistency?: boolean;
  selfConsistencySamples?: number;
  reflexion?: boolean;
  calibrate?: boolean;
  _calibration?: Record<string, { wins: number; losses: number }>;
  _groundTruth?: unknown;
  analytical?: boolean;
  cognitiveFlow?: boolean;
  _skipAnalytical?: boolean;
  _skipCognitiveFlow?: boolean;
  systemPrompt?: string;
  autoSystemPrompt?: boolean;
  images?: string[];
  enableCode?: boolean;
  samplingProfile?: keyof typeof SAMPLING;
  options?: Record<string, unknown>;
  format?: string | object;
  think?: boolean | string;
  keep_alive?: string;
  max_tokens?: number;
  ollamaOutput?: boolean;
  autoChoose?: boolean;
  forceStream?: boolean;
  _globalBudget?: { llmCalls: number; maxLLMCalls: number };
  _brain?: Brain;
  humanBrain?: boolean;
  maxCheckIterations?: number;
  monitorWindowSize?: number;
  _lastResultFailed?: string;
  _compressMessages?: ChatMessage[];
  _truncatableMessages?: ChatMessage[];
  verbose?: boolean;
  provider?: string;
  // trace plumbing — set by generate(), read by callChat
  _trace?: TraceStore;
  _phase?: string;
  _depth?: number;
  _parentCallId?: number | null;
  [k: string]: unknown;
};

type BrainLike = { isOverCapacity: () => boolean; evict: () => unknown[]; appendToSemantic: (s: string) => void; add: (k: string, v: string, p?: number) => void; getContextBlock: () => string; workingMemory: unknown[] };

class Brain {
  workingMemory: Array<{ _failCount?: number } & Record<string, unknown>> = [];
  semantic: string[] = [];
  capacity: number;
  constructor(opts: { capacity?: number } = {}) {
    this.capacity = opts.capacity ?? 30;
  }
  isOverCapacity(): boolean {
    return this.workingMemory.length > this.capacity;
  }
  evict(): Array<Record<string, unknown>> {
    const dropped = this.workingMemory.splice(0, this.workingMemory.length - this.capacity);
    return dropped;
  }
  appendToSemantic(s: string): void {
    this.semantic.push(s);
  }
  add(k: string, v: string, p = 5): void {
    this.workingMemory.push({ key: k, value: v, priority: p, ts: Date.now() });
  }
  getContextBlock(): string {
    const items = this.workingMemory.map(i => `[${(i as Record<string, unknown>).key}] ${(i as Record<string, unknown>).value}`).join('\n');
    const sem = this.semantic.length ? `\nSEMANTIC FACTS:\n${this.semantic.join('\n')}` : '';
    return items ? `WORKING MEMORY:\n${items}${sem}` : '';
  }
}

class Async {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    this.chain = next.catch(() => undefined);
    return next;
  }
}

class Metacognitive {
  windowSize: number;
  similarityThreshold: number;
  maxSameFeedback: number;
  _rHist: string[];
  _fHist: string[];
  interventions: number;
  _best: string | null;
  _bestScore: number;
  emit: (event: string, payload: LogEvent) => void;
  constructor(opts: { windowSize?: number; similarityThreshold?: number; maxSameFeedback?: number; emit?: (event: string, payload: LogEvent) => void } = {}) {
    this.windowSize = opts.windowSize ?? 5;
    this.similarityThreshold = opts.similarityThreshold ?? 0.82;
    this.maxSameFeedback = opts.maxSameFeedback ?? 2;
    this._rHist = [];
    this._fHist = [];
    this.interventions = 0;
    this._best = null;
    this._bestScore = -Infinity;
    this.emit = opts.emit ?? (() => {});
  }
  _score(text: string, passed = 0): number {
    return passed * 10 + Math.min(text.trim().length, 200) / 200;
  }
  updateBest(text: string, passed = 0): void {
    const s = this._score(text, passed);
    if (s > this._bestScore) {
      this._bestScore = s;
      this._best = text;
    }
  }
  _jaccard(a: string, b: string, n = 4): number {
    const g = (s: string) => {
      const st = new Set<string>();
      const norm = s.toLowerCase().replace(/\s+/g, ' ');
      for (let i = 0; i <= norm.length - n; i++) st.add(norm.slice(i, i + n));
      return st;
    };
    const ga = g(a);
    const gb = g(b);
    if (!ga.size && !gb.size) return 1;
    if (!ga.size || !gb.size) return 0;
    let inter = 0;
    for (const x of ga) if (gb.has(x)) inter++;
    return inter / (ga.size + gb.size - inter);
  }
  trackResponse(text: string): boolean {
    const key = text.trim().replace(/\s+/g, ' ');
    this._rHist.push(key);
    if (this._rHist.length > this.windowSize) this._rHist.shift();
    return this._rHist.length >= 2 && this._rHist.slice(0, -1).some((p: string) => this._jaccard(key, p) > this.similarityThreshold);
  }
  trackFeedback(failed: Check[]): boolean {
    const key = failed.map(f => f.feedback || '').sort().join('||');
    this._fHist.push(key);
    if (this._fHist.length > this.maxSameFeedback + 1) this._fHist.shift();
    const win = this._fHist.slice(-this.maxSameFeedback);
    return win.length >= this.maxSameFeedback && win.every(f => this._jaccard(f, key, 3) > 0.72);
  }
  interrupt(current: string): string {
    this.interventions++;
    this.emit('log', { level: 'warn', msg: `[METACOGNITIVE INTERRUPT #${this.interventions}] Returning best response.`, source: 'metacog', ts: Date.now() });
    return this._best || current;
  }
  reset(): void {
    this._rHist = [];
    this._fHist = [];
    this._best = null;
    this._bestScore = -Infinity;
  }
}

function consolidateSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const sandboxMsgs: ChatMessage[] = [];
  const regular: ChatMessage[] = [];
  const nonSys: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'system') {
      nonSys.push(m);
      continue;
    }
    if (m.content.startsWith(sandbox)) sandboxMsgs.push(m);
    else regular.push(m);
  }
  const out: ChatMessage[] = sandboxMsgs.map(m => ({
    role: 'system',
    content: m.content.slice(sandbox.length)
  }));
  if (regular.length) {
    const merged = regular.map(m => m.content).join('\n\n---\n\n');
    out.push({ role: 'system', content: merged });
  }
  return [...out, ...nonSys.map(cloneMessage as (m: ChatMessage) => ChatMessage)];
}

function insertSystemPrompt(messages: ChatMessage[], sys: string): ChatMessage[] {
  if (!sys) return messages.map(cloneMessage as (m: ChatMessage) => ChatMessage);
  return [{ role: 'system', content: sys }, ...messages.map(cloneMessage as (m: ChatMessage) => ChatMessage)];
}

/** serialize messages for the trace log — images replaced with a marker so
 *  base64 blobs never blow up the audit trail. */
function tracePrompt(messages: ChatMessage[]): string {
  const redacted = messages.map(m => {
    if (Array.isArray(m.images) && m.images.length) {
      return { ...m, images: [`<${m.images.length} image(s) redacted>`] };
    }
    return m;
  });
  const txt = JSON.stringify(redacted);
  return txt.length > 8000 ? txt.slice(0, 8000) + '…[truncated]' : txt;
}

/** cheap guard: does this input look computational at all? skips the
 *  detectComputeNeeds LLM call for pure-prose requests. */
function looksComputational(inputText: string): boolean {
  return (
    /\d/.test(inputText) ||
    /calculate|compute|solve|evaluate|sum|difference|product|quotient|multiply|divide|add |subtract|count|convert|parse|fibonacci|prime|factorial|greatest|least common|probability|integral|derivative|generate a (list|table|sequence)|sort |sorting|matrix|equation|number of ways|ways to|how many|pairs? \(|enumerate|partition/i.test(inputText)
  );
}

/** cheap guard: does this input look like a proof problem? — triggers
 *  proof-specific workflow (case coverage, lemma validation, counterexample search) */
function isProofProblem(inputText: string): boolean {
  // proof language without computational markers = proof problem
  return (
    /prove that|show that|determine all|find all|for every|for all|must be/i.test(inputText) &&
    !/compute|evaluate|calculate|what is|find the value/i.test(inputText)
  );
}

/** cheap difficulty router: long + proof/quantifier language + math
 *  vocabulary + depth → hard. drives probe escalation + budget forcing. */
function estimateDifficulty(inputText: string, depth: number): boolean {
  let score = 0;
  if (inputText.length > 500) score++;
  if (/prove|show that|find all|for all n|for every|determine all|is it possible|must be/i.test(inputText)) score++;
  if (/integer|prime|modulo|mod |divisib|permutation|combinator|probability|expected|sequence|polynomial|triangle|circle|convex/i.test(inputText)) score++;
  if (depth >= 3) score++;
  return score >= 2;
}

/** probe dumps are verbose LaTeX — the final call only needs the reasoning
 *  flavor + every probe's ANSWER line (which sits at the block tail). cut
 *  each block to head+tail so the re-sent thinkCtx shrinks ~3x without
 *  losing the votes. */
function compressProbeDump(s: string): string {
  if (!s || s.length <= 1500) return s;
  const blocks = s.split(/\n(?=[A-Z]+:\n)/);
  if (blocks.length <= 1) return s.slice(0, 700) + '\n[...]\n' + s.slice(-700);
  return blocks.map((b) => {
    if (b.length <= 700) return b;
    return b.slice(0, 300) + '\n[...]\n' + b.slice(-300);
  }).join('\n');
}

/** pull the answer value out of a formatted response: the "ANSWER: X" line,
 *  or [X] on the last line, else the whole trimmed text. */
function extractAnswerValue(text: string): string {
  if (!text) return '';
  const m = text.match(/ANSWER\s*:\s*([^\n]+)/i);
  if (m) return m[1].trim();
  const b = text.match(/\[([^\]]+)\]\s*$/m);
  if (b) return b[1].trim();
  return text.trim();
}

/** loose equality for answer comparison: case, whitespace, trailing period */
function normAnswer(s: string): string {
  return String(s).trim().toLowerCase().replace(/[.\s]+$/g, '').replace(/\s+/g, ' ');
}

/** the OUTPUT FORMAT directive for the caller's requested answer shape —
 *  shared by the final call and the independent self-consistency sample. */
function buildFormatDirective(mergedOpts: any, type: any): string {
  if (mergedOpts.answerFormat === 'bracket' && type !== 'json') {
    return 'OUTPUT FORMAT: end your response with the final answer alone on the last line, in square brackets - e.g. [42] or [sqrt(2)/3]. Nothing may follow the closing bracket.';
  }
  const sysText = typeof mergedOpts.systemPrompt === 'string' ? mergedOpts.systemPrompt : '';
  if (/ANSWER\s*:/.test(sysText) && type !== 'json') {
    return 'OUTPUT FORMAT: end your response with the final answer on a line starting with "ANSWER: ". If the problem lists numbered choices, answer with the choice NUMBER only (e.g. "ANSWER: 3" for choice 3) — never the value itself. Nothing after that line.';
  }
  // answer("...") — the benchmark runner's DT_SYS asks for a quoted final
  // answer so the extractor regex can pull it cleanly off the proof prose.
  // without this directive the model buries the conclusion mid-proof and
  // the answer never survives extraction.
  if (/answer\s*\(/.test(sysText) && type !== 'json') {
    return 'OUTPUT FORMAT: end your response with exactly one final line in the form answer("your answer here") — the complete answer inside double quotes, LaTeX written cleanly. For a proof, put the proven conclusion inside the quotes. Nothing may follow that line.';
  }
  return '';
}

/** pull a Retry-After hint out of an error message if the server sent one */
function parseRetryAfter(err: unknown): number | null {
  const m = String((err as Error)?.message || '');
  const hit = m.match(/retry[- ]?after[:\s]+(\d+)/i);
  if (hit) return Math.min(Number(hit[1]) * 1000, 60_000);
  return null;
}

/** detect a response that got cut off mid-thought. small models emit EOS
 *  mid-formula on hard proofs; shipping the fragment as the final answer is
 *  worse than retrying. signals: unclosed math delimiters, dangling LaTeX
 *  braces/backslashes, or a long response that never reaches a conclusion
 *  and ends mid-sentence. */
function looksTruncated(text: string): boolean {
  const t = String(text || '').trim();
  if (t.length < 60) return false;
  const dollars = (t.match(/\$/g) || []).length;
  if (dollars % 2 === 1) return true;                    // unclosed math
  if (/\$\$\s*$/.test(t)) return true;                   // unclosed display math
  if (/\\[a-zA-Z]+\{\s*$/.test(t)) return true;          // dangling \frac{ etc
  if (/\\begin\{[a-z]*\*?\s*$/.test(t)) return true;     // unclosed environment
  if (/[{(\\[]\s*$/.test(t)) return true;                // ends mid-expression
  if (t.length > 400 && /[a-z0-9]$/.test(t) && !/(therefore|hence|conclusion|we conclude|thus|qed|□|proved|shown|answer)/i.test(t)) {
    return true;                                         // long, no conclusion, mid-sentence
  }
  return false;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Deepthink extends EventEmitter {
  model: string;
  auditModel: string;
  apiKeys: string[];
  currentKeyIndex: number;
  clientOptions: Record<string, unknown>;
  limiter: PQueue;
  concurrencyScaler: AdaptiveConcurrency | null;
  traceMode: string;
  _keyFailures: Map<string, { count: number; quarantineUntil: number }>;
  _keyMutex: Async;
  _globalLogBridge: (e: LogEvent) => void;
  // trace + batch accounting
  _lastTrace: TraceStore | null;
  _activeCalls: number;
  _batch: { calls: number; errors: number; rateLimited: number; timeouts: number; latencies: number[] };

  constructor(model?: string, apiKeys: string[] = [], clientOptions: Record<string, unknown> = {}, concurrency: number = Infinity, auditModel: string | null = null, extra: { adaptiveConcurrency?: boolean; traceMode?: string; maxConcurrency?: number } = {}) {
    super();
    this.model = model || process.env.OLLAMA_MODEL || 'llama3.1';
    this.auditModel = auditModel || this.model;
    this.apiKeys = Array.isArray(apiKeys) ? apiKeys.map(k => String(k).trim()).filter(Boolean) : [];
    this.currentKeyIndex = 0;
    this.clientOptions = clientOptions || {};
    this.traceMode = extra.traceMode ?? 'flat';
    this._lastTrace = null;
    this._activeCalls = 0;
    this._batch = { calls: 0, errors: 0, rateLimited: 0, timeouts: 0, latencies: [] };
    // adaptive concurrency: on unless the caller pinned a finite level
    const adaptive = extra.adaptiveConcurrency ?? true;
    if (adaptive && (concurrency === Infinity || concurrency > 0)) {
      this.concurrencyScaler = new AdaptiveConcurrency({
        model: this.model,
        start: concurrency === Infinity ? 2 : concurrency,
        max: extra.maxConcurrency ?? 32,
        onEvent: (m) => this._log('info', 'concurrency', m)
      });
      this.limiter = new PQueue({ concurrency: this.concurrencyScaler.current });
    } else {
      this.concurrencyScaler = null;
      this.limiter = new PQueue({ concurrency: concurrency === Infinity ? Infinity : concurrency });
    }
    this._keyFailures = new Map();
    this._keyMutex = new Async();
    // bridge module-level events onto this instance's emitter
    this._globalLogBridge = (e) => this.emit('log', e);
    globalEmitter.on('log', this._globalLogBridge);
  }
/**
   * Cleans up global event listeners to prevent memory leaks.
   * Call this when you are finished with a Deepthink instance in long-running applications.
   */
  destroy(): void {
    globalEmitter.off('log', this._globalLogBridge);
    this.concurrencyScaler?.save();
    this.removeAllListeners();
  }
  _log(level: LogLevel, source: string, msg: string): void {
    this.emit('log', { level, source, msg, ts: Date.now() } as LogEvent);
  }

  _syncConcurrency(): void {
    if (this.concurrencyScaler) {
      this.limiter.concurrency = this.concurrencyScaler.current;
    }
  }

  /** accumulate per-call stats (attempts that hit the wire) */
  _recordBatchCall(ok: boolean, rateLimited: boolean, timedOut: boolean, latencyMs: number): void {
    this._batch.calls++;
    if (!ok) this._batch.errors++;
    if (rateLimited) this._batch.rateLimited++;
    if (timedOut) this._batch.timeouts++;
    if (latencyMs > 0) this._batch.latencies.push(latencyMs);
  }

  /** when all in-flight work drains, hand the batch to the scaler so it
   *  can double/hold/halve. */
  _maybeFlushBatch(): void {
    if (this._activeCalls > 0) return;
    const b = this._batch;
    if (b.calls === 0) return;
    this._batch = { calls: 0, errors: 0, rateLimited: 0, timeouts: 0, latencies: [] };
    const sorted = [...b.latencies].sort((x, y) => x - y);
    const avg = b.latencies.length ? b.latencies.reduce((a, x) => a + x, 0) / b.latencies.length : 0;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    this.concurrencyScaler?.onBatch({ calls: b.calls, errors: b.errors, rateLimited: b.rateLimited, timeouts: b.timeouts, avgLatencyMs: avg, p95LatencyMs: p95 });
    this._syncConcurrency();
    this._log('info', 'concurrency', `batch: ${b.calls} calls, avg ${avg.toFixed(0)}ms, p95 ${p95.toFixed(0)}ms, ${b.errors} errors, ${b.rateLimited} rate-limited → concurrency ${this.concurrencyScaler?.current ?? this.limiter.concurrency}`);
  }

  async getNextApiKey(): Promise<string | null> {
    return this._keyMutex.run(async () => {
      if (!this.apiKeys.length) return null;
      const now = Date.now();
      for (let i = 0; i < this.apiKeys.length; i++) {
        const idx = (this.currentKeyIndex + i) % this.apiKeys.length;
        const key = this.apiKeys[idx];
        const rec = this._keyFailures.get(key);
        if (!rec || now > (rec.quarantineUntil || 0)) {
          this.currentKeyIndex = (idx + 1) % this.apiKeys.length;
          return key;
        }
      }
      let soonest: string | null = null;
      let t = Infinity;
      for (const [k, r] of this._keyFailures) {
        if ((r.quarantineUntil || 0) < t) {
          t = r.quarantineUntil;
          soonest = k;
        }
      }
      return soonest;
    });
  }

  _markKeyFailure(key: string | null): void {
    if (!key) return;
    this._keyMutex.run(async () => {
      const rec = this._keyFailures.get(key) || { count: 0, quarantineUntil: 0 };
      if (++rec.count >= 2) rec.quarantineUntil = Date.now() + 60_000;
      this._keyFailures.set(key, rec);
    });
  }

  _markKeySuccess(key: string | null): void {
    if (key) this._keyFailures.delete(key);
  }

  buildClient(key: string | null): ProviderClient {
    const providerOpts: Record<string, unknown> = this.clientOptions.provider ? this.clientOptions : {
      provider: 'ollama',
      ...this.clientOptions
    };
    return buildProviderClient(providerOpts as { provider: string }, key) as unknown as ProviderClient;
  }

  normalizeMessages(input: unknown, opts: DeepthinkOptions = {}): ChatMessage[] {
    const messages = normalizeInputToMessages(input);
    if (!opts.autoSystemPrompt) return messages;
    const sys = typeof opts.systemPrompt === 'string' ? opts.systemPrompt.trim() : '';
    return insertSystemPrompt(messages, sys || createDefaultSystemPrompt(opts.type || 'string', opts.depth ?? 0));
  }

  async callChat(messages: ChatMessage[], stream: boolean = false, onChunk: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null = null, opts: DeepthinkOptions = {}): Promise<ChatResult> {
    if (opts.autoChoose) {
      // hyperparameter tuner: bounded — falls back to defaults instead of
      // looping forever if the model refuses to emit JSON.
      let validSettings: { temperature: number; top_p: number; top_k: number } | null = null;
      for (let tries = 0; tries < 3 && !validSettings; tries++) {
        try {
          const metaOpts: DeepthinkOptions = { ...opts, autoChoose: false, think: false, format: 'json', _phase: 'meta', _depth: 1 };
          const sysPrompt = 'You are a hyperparameter tuner for LLM inference. ' +
            'Select the optimal sampling parameters for the task type described.\n\n' +
            'PARAMETER GUIDE:\n' +
            '  - Code generation: temperature=0.1, top_p=0.8, top_k=20\n' +
            '  - JSON/structured output: temperature=0.0, top_p=1.0, top_k=1\n' +
            '  - Creative/generative writing: temperature=0.7-0.9, top_p=0.8-0.95, top_k=20-50\n' +
            '  - Reasoning/analysis: temperature=0.5-0.6, top_p=0.8, top_k=20\n' +
            '  - Factual Q&A/verification: temperature=0.0-0.2, top_p=0.8, top_k=10\n\n' +
            'Output ONLY valid JSON: {"temperature":0.7,"top_p":0.9,"top_k":40}';
          const msgContext = JSON.stringify(messages);
          const metaR = await this.callChat([{ role: 'system', content: sysPrompt }, { role: 'user', content: `Select optimal sampling parameters for this task:\n${msgContext}` }], false, null, metaOpts);
          const match = (metaR.content || '').match(/\{[\s\S]*\}/);
          if (!match) throw new Error('No JSON detected');
          const parsed = JSON.parse(match[0]);
          if ('temperature' in parsed && 'top_p' in parsed && 'top_k' in parsed) {
            const temp = Number(parsed.temperature);
            const p = Number(parsed.top_p);
            const k = Number(parsed.top_k);
            if (!isNaN(temp) && !isNaN(p) && !isNaN(k)) {
              validSettings = { temperature: temp, top_p: p, top_k: k };
            }
          }
        } catch {
          // retry, then fall through to defaults
        }
      }
      if (validSettings) {
        opts = { ...opts, autoChoose: false };
        opts.options = { ...(opts.options || {}), ...validSettings };
      } else {
        opts = { ...opts, autoChoose: false };
      }
    }

    if (opts._globalBudget) {
      opts._globalBudget.llmCalls = (opts._globalBudget.llmCalls || 0) + 1;
      if (opts._globalBudget.llmCalls > (opts._globalBudget.maxLLMCalls || 300)) {
        throw new Error('Global LLM call budget exhausted');
      }
    }

    // trace: record every call with full prompt/response + timing
    const trace = opts._trace ?? null;
    const phase = opts._phase || 'unknown';
    const t0 = Date.now();
    this._activeCalls++;
    const callId = trace
      ? trace.begin({ phase, model: (opts.model || this.model) as string, prompt: tracePrompt(messages), concurrency: this._activeCalls, parentCallId: opts._parentCallId ?? trace.parentCallId, depth: opts._depth ?? trace.depth })
      : null;

    const maxAttempts = 3;
    let useStream = opts.forceStream !== false;
    let lastErr: Error | undefined;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // gate on the scaler's backoff window if we just got throttled
        if (this.concurrencyScaler) await this.concurrencyScaler.waitForDispatch();
        const key = (await this.getNextApiKey()) || process.env.OLLAMA_API_KEY || null;
        const client = this.buildClient(key);
        const samplingProfile = SAMPLING[opts.samplingProfile || 'creative'] || {};
        const mergedOptions: Record<string, unknown> = {
          ...qwen,
          ...samplingProfile,
          ...(opts.options || {})
        };
        try {
          const result = await this.limiter.add(() => client.chat({
            model: opts.model || this.model,
            messages: consolidateSystemMessages(messages),
            stream: useStream,
            options: mergedOptions,
            think: opts.think,
            format: opts.format,
            keep_alive: opts.keep_alive,
            max_tokens: opts.max_tokens,
            onChunk: stream && typeof onChunk === 'function' ? onChunk : null,
            ollamaOutput: opts.ollamaOutput
          }));
          this._markKeySuccess(key);
          if (trace) trace.end(callId as number, {
            latencyMs: Date.now() - t0,
            response: (result.content || '') + ((result.thinking || '') ? `\n[thinking]\n${result.thinking}` : ''),
            promptTokens: result.promptTokens ?? null,
            responseTokens: result.responseTokens ?? null,
            status: 'ok'
          });
          this._recordBatchCall(true, false, false, Date.now() - t0);
          return result as ChatResult;
        } catch (err: unknown) {
          lastErr = err as Error;
          this._markKeyFailure(key);
          const rateLimited = isRateLimitError(err);
          const timedOut = isTimeoutError(err);
          this.concurrencyScaler?.onError(err);
          this._syncConcurrency();
          this._recordBatchCall(false, rateLimited, timedOut, Date.now() - t0);
          if (attempt === 0 && !rateLimited && /stream|chunked/i.test(lastErr.message) && useStream) {
            useStream = false;
            continue;
          }
          if (attempt < maxAttempts - 1) {
            const retryAfter = parseRetryAfter(err);
            const base = rateLimited ? 1500 : timedOut ? 1000 : 500;
            const wait = retryAfter ?? base * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
            this._log('warn', 'callChat', `attempt ${attempt + 1} failed (${(err as Error).message.slice(0, 80)}), retrying in ${wait}ms`);
            await sleep(wait);
          }
        }
      }
      throw lastErr;
    } catch (err: unknown) {
      if (trace) trace.end(callId as number, {
        latencyMs: Date.now() - t0,
        status: isTimeoutError(err) ? 'timeout' : 'error',
        error: (err as Error).message
      });
      throw err;
    } finally {
      this._activeCalls--;
      this._maybeFlushBatch();
    }
  }

  async detectComputeNeeds(input: unknown, opts: DeepthinkOptions = {}): Promise<{ mode: 'none' | 'single' | 'parallel'; task?: string; tasks?: string[] }> {
    const inputText = messagesToText(input);
    const sys = 'You are a Compute Orchestrator. Your goal is to determine if a request requires precise computational verification via a sandbox to prevent hallucinations.\n\n' +
      'CLASSIFICATION PROTOCOL:\n' +
      '  - mode: "none" -> The request is conceptual, qualitative, or an open-ended reasoning task.\n' +
      '  - mode: "single" -> The request requires a single, definite numeric, symbolic, or algorithmic result (e.g., "What is 2^100?", "Calculate the 50th Fibonacci number").\n' +
      '  - mode: "parallel" -> The request requires multiple independent computations that can be run concurrently (e.g., "Calculate the first 5 primes and their sum").\n\n' +
      'SENSITIVITY GUIDE:\n' +
      '  - If the answer depends on a precise mathematical property, an iterative loop, or a complex combination, use "single" or "parallel".\n' +
      '  - If the request asks "how many", "number of ways", "find the number", or "count the" — the answer is a definite integer → use "single" or "parallel".\n' +
      '  - If the task is a "sanity check" on a number, use "single".\n' +
      '  - "task" must be a SHORT (1-2 sentence) description of the computation to run — never code, never reasoning.\n\n' +
      'Output ONLY valid JSON - no markdown, no prose:\n' +
      '{"mode":"none" | "single" | "parallel", "task":"<the precise executable task>", "tasks":["<task1>", "<task2>"]}';
    const r = await this.callChat([{ role: 'system', content: sys }, { role: 'user', content: inputText }], false, null, { ...opts, think: false, samplingProfile: 'json', _phase: 'compute', _depth: 2 });
    // the orchestrator embeds the task as a JSON string — when the task is
    // code, a raw backslash (\d in a regex, \n inside a python string) breaks
    // the whole parse and silently kills codegen (a26ii-13: orchestrator
    // derived 107, parse threw, hand-reasoning returned 16). never throw:
    // fall back to brace-matched extraction, then repair bad escapes.
    const parse = (txt: string): { mode: 'none' | 'single' | 'parallel'; task?: string; tasks?: string[] } => {
      const t = (txt || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      const tryParse = (s: string): any => {
        try { return JSON.parse(s); } catch { return null; }
      };
      let p: any = tryParse(t);
      if (!p) {
        // brace-matched object scan — survives prose around the JSON
        const start = t.indexOf('{');
        if (start >= 0) {
          let depth = 0, inStr = false, esc = false;
          for (let i = start; i < t.length; i++) {
            const c = t[i];
            if (inStr) {
              if (esc) esc = false;
              else if (c === '\\') esc = true;
              else if (c === '"') inStr = false;
            } else if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                const cand = t.slice(start, i + 1);
                p = tryParse(cand);
                if (!p) {
                  // repair: backslash before a non-JSON-escape char → double
                  // it; \u followed by non-hex → double it too
                  p = tryParse(
                    cand
                      .replace(/\\([^"\\/bfnrtu])/g, '\\\\$1')
                      .replace(/\\(u)(?![0-9a-fA-F]{4})/g, '\\\\$1')
                  );
                }
                break;
              }
            }
          }
        }
      }
      if (!p || !p.mode || p.mode === 'none') return { mode: 'none' };
      if (p.mode === 'parallel' && Array.isArray(p.tasks) && p.tasks.length >= 2) return { mode: 'parallel', tasks: p.tasks.slice(0, 4) };
      if (p.mode === 'single' && p.task) return { mode: 'single', task: p.task };
      return { mode: 'none' };
    };
    const first = parse(r.content || '');
    if (first.mode !== 'none') return first;
    // counting problems are definite-integer answers — the orchestrator
    // sometimes classifies them as conceptual (a26i-15: "number of ways"
    // → none, then the model hand-counted wrong). re-ask with a nudge.
    if (/number of ways|how many|find the number|in how many|count the number/i.test(inputText)) {
      const r2 = await this.callChat(
        [{ role: 'system', content: sys }, { role: 'user', content: inputText + '\n\nNOTE: this request asks for a definite count. It requires a numeric answer — classify as "single" or "parallel", not "none".' }],
        false, null, { ...opts, think: false, samplingProfile: 'json', _phase: 'compute', _depth: 2 }
      );
      const second = parse(r2.content || '');
      if (second.mode !== 'none') return second;
    }
    return first;
  }

  async runChecks(input: unknown, response: string, checksCount: number, opts: DeepthinkOptions = {}, groundTruth: { value: unknown; sandboxValidated?: boolean } | null = null, sandboxPrefix: ChatMessage[] = []): Promise<CheckResult[]> {
    const inputText = messagesToText(input);
    const gtVal = groundTruth?.sandboxValidated ? String(groundTruth.value).trim() : null;
    // checkStyle: 'full' = checker audits the whole draft; 'blind' (DEFAULT)
    // = checker sees ONLY the claimed answer and must re-derive it
    // (verifier-blind — fresh-context verifier subagents outperform
    // self-critique per Anthropic's documented recipe).
    const blind = opts.checkStyle !== 'full';
    const claimed = blind ? (() => {
      const m = response.match(/ANSWER\s*:\s*([^\n]+)/i);
      if (m) return m[1].trim();
      const b = response.match(/\[([^\]]+)\]\s*$/m);
      if (b) return b[1].trim();
      return response.trim().slice(-160);
    })() : null;
    const personas = [{
      label: 'Standard',
      system: gtVal
        ? `You are a Ground Truth Verifier. The sandbox-verified answer is [${gtVal}]. Your sole mission is to detect any deviation from this value. If the response contradicts this value or omits it where required, you MUST return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
        : blind
          ? `You are an Independent Verifier. You see ONLY the claimed answer, never the reasoning. Solve the problem yourself from scratch and judge whether the claim is correct. If it is wrong, or you cannot confirm it, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
          : `You are a Quality Assurance Specialist. Audit the response for correctness, completeness, and adherence to the user's constraints. If any critical detail is missing or incorrect, you MUST return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
    }, {
      label: 'Adversarial',
      system: gtVal
        ? `You are a Red-Team Auditor. The verified answer is [${gtVal}]. Your goal is to dismantle the response. Look for "hallucinated precision" (adding detail that isn't true), logical leaps, or subtle deviations from the ground truth. If you find ANY flaw, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
        : blind
          ? `You are an Adversarial Verifier. You see ONLY the claimed answer. Solve the problem independently, then attack the claim from every angle. Only return YES if the claim is unquestionably correct. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
          : `You are a Red-Team Auditor. Assume the response contains a subtle error, a logical gap, or a hallucination. Be ruthless. Only return YES if the response is absolutely flawless. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
    }, {
      label: 'Numerical',
      model: this.auditModel,
      system: gtVal
        ? `You are a Numerical Forensic Analyst. Does the response explicitly and correctly state the verified value [${gtVal}]? Any rounding error, sign flip, or missing digit is a failure. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
        : blind
          ? `You are a Numerical Verifier. Recompute the claimed answer yourself. Any rounding error, sign flip, or missing digit means the claim is wrong — return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
          : `You are a Numerical Forensic Analyst. Audit every number and calculation in the response. Check for internal consistency, order-of-magnitude errors, and precision loss. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
    }, {
      label: 'Backward',
      system: gtVal
        ? `You are a Backward Verifier. The verified answer is [${gtVal}]. Reconstruct the original problem from the response, then diff it against the actual input. Flag any constraint the response misread, missed, or added, and any edge case ignored. If the response's reasoning contradicts the verified value, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
        : blind
          ? `You are a Backward Verifier. You see ONLY the claimed answer. Reconstruct the problem that would produce this answer, then compare against the actual input. If the claimed answer implies a different problem than the one asked, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
          : `You are a Backward Verifier. Reconstruct the original problem from the response, then diff it against the actual input. Flag every constraint the response misread, missed, or added, and every edge case ignored. If the response solved a different problem than the one asked, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}`
    }];
    // step-level (process) verification for hard problems — PRM800K: process
    // supervision beats outcome supervision (78.2 vs 72.4). needs the FULL
    // solution, not the blind claimed answer, so it gets its own display.
    if ((opts.depth ?? 0) >= 3) {
      personas.push({
        label: 'StepLevel',
        full: true,
        system: 'You are a Step-Level Verifier. Below is a solution broken into numbered steps. For EACH step, judge whether it is correct (sound math, no logical leaps, no misread constraints). A single wrong step invalidates the whole solution. Output ONLY valid JSON: {"step_scores":[0.0,1.0,...],"verdict":"YES/NO","reason":"..."}'
      });
    }
    // proof-specific personas — triggered when the input looks like a proof
    // problem (USAMO/Putnam style: "prove that", "find all", "determine all")
    if (isProofProblem(inputText)) {
      personas.push({
        label: 'CaseCoverage',
        full: true,
        system: 'You are a Case Exhaustion Checker for proof problems. Verify that ALL cases are enumerated and covered. Look for: (1) missing boundary cases (n=0, n=1, edge values), (2) unproven "without loss of generality" claims, (3) cases assumed but not checked. If ANY case is missing or unproven, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
      });
      personas.push({
        label: 'LemmaValidator',
        full: true,
        system: 'You are a Lemma Validator for proof problems. Check that EVERY intermediate claim is justified (not assumed). Look for: (1) "clearly" / "obviously" without proof, (2) circular reasoning, (3) claims that need a lemma but don\'t have one. If ANY lemma is unjustified, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
      });
      personas.push({
        label: 'CounterexampleSearch',
        full: true,
        system: 'You are a Counterexample Hunter for proof problems. Your ONLY job is to find a counterexample that breaks the claimed result. Try: (1) edge cases (n=0, n=1, large n), (2) special structures (primes, perfect squares), (3) boundary values. If you find ANY counterexample, return NO. Output ONLY valid JSON: {"verdict":"YES/NO","reason":"..."}'
      });
    }
    const personasFinal = personas.slice(0, Math.min(checksCount, 6));  // increased from 4 to 6 to fit proof personas

    const shown = claimed ? `<claimed answer>\n${claimed}\n</claimed answer>` : response;

    // full-response checkers just audit (150 is plenty); claimed-only checkers
    // must re-derive the answer, and a 150-token cap was truncating them
    // mid-derivation → guaranteed spurious NO verdicts → revision churn
    const results = await Promise.allSettled(personasFinal.map(p => this.callChat([...sandboxPrefix, { role: 'system', content: p.system }, { role: 'user', content: `<input>\n${inputText}\n</input>\n\n<response>\n${p.full ? response : shown}\n</response>\n\nVerdict:` }], false, null, { ...opts, think: false, model: p.model || this.auditModel, samplingProfile: 'verify', _phase: 'checks', _depth: 3, options: { ...(opts.options || {}), num_predict: p.full ? 150 : 1000 } })));

    return results.map((r, i) => {
      const p = personasFinal[i];
      if (r.status === 'rejected') {
        return { correct: false, feedback: `Checker (${p.label}): ${(r.reason as Error)?.message}` };
      }
      const text = (r.value.content || '').trim();
      let verdict: string | undefined;
      let reason: string | undefined;
      try {
        const j = JSON.parse(text);
        verdict = j.verdict;
        reason = j.reason;
      } catch {
        verdict = /^YES/i.test(text) ? 'YES' : 'NO';
        reason = text.replace(/^NO[:\s]*/i, '');
      }
      const ok = /^YES$/i.test(String(verdict || ''));
      return { correct: ok, feedback: ok ? null : reason || `Checker (${p.label}) flagged response.` };
    });
  }

  async consolidateBrainMemory(brain: Brain, opts: DeepthinkOptions = {}): Promise<void> {
    if (!(brain instanceof Brain) || !brain.isOverCapacity()) return;
    const evicted = brain.evict();
    if (!evicted.length) return;
    try {
      const r = await this.callChat([{
        role: 'system',
        content: 'Compress the following memory items into dense semantic facts.\n' +
          'Rules:\n' +
          '  - Preserve all specific values, numbers, and key conclusions.\n' +
          '  - Remove redundancy and filler.\n' +
          '  - Output ONLY the compressed plain text, no JSON, no labels.'
      }, { role: 'user', content: JSON.stringify(evicted, null, 2) }], false, null, { ...opts, think: false, samplingProfile: 'reasoning', _phase: 'memory', _depth: 2 });
      brain.appendToSemantic((r.content || '').trim());
    } catch (err: unknown) {
      this._log('warn', 'brain', `Consolidation failed: ${(err as Error).message}`);
      for (const item of evicted) {
        if (((item as { _failCount?: number })._failCount || 0) < 1) {
          brain.workingMemory.push({ ...(item as Record<string, unknown>), _failCount: ((item as { _failCount?: number })._failCount || 0) + 1 });
        }
      }
    }
  }

  async generate(input: unknown, opts: DeepthinkOptions = {}): Promise<unknown> {
    const type = opts.type ?? 'string';
    const depth = opts.depth ?? 1;
    const checks = opts.checks ?? 0;
    const onChunk = opts.onChunk ?? null;
    const mergedOpts: DeepthinkOptions = { ...opts, type, depth };
    const brain = mergedOpts.humanBrain ? (mergedOpts._brain instanceof Brain ? mergedOpts._brain : new Brain()) : null;

    // trace: one store per generation, threaded through every call
    const trace = (mergedOpts._trace instanceof TraceStore ? mergedOpts._trace : null) ?? new TraceStore(this.traceMode === 'off' ? 'off' : 'flat', 500);
    mergedOpts._trace = trace;
    this._lastTrace = trace;
    trace.markStart();
    const traceScope = trace.pushScope('generate');
    try {
      return await this._generateInner(input, type, depth, checks, onChunk, mergedOpts, brain, trace);
    } finally {
      trace.popScope();
      if (trace.size > 0) {
        this.emit('trace', trace);
        this._log('info', 'trace', trace.summarize());
      }
    }
  }

  private async _generateInner(input: unknown, type: string, depth: number, checks: number, onChunk: ((chunk: string, meta: { kind: 'content' | 'thinking' }) => void) | null, mergedOpts: DeepthinkOptions, brain: Brain | null, trace: TraceStore): Promise<unknown> {
    if (Array.isArray(mergedOpts.mixtureModels) && mergedOpts.mixtureModels.length >= 2) {
      const bound = mergedOpts.mixtureModels.map(m => ({
        name: typeof m === 'string' ? m : m.name,
        callChat: typeof m === 'string' ? this.callChat.bind(this) : ((m.callChat || this.callChat.bind(this)) as (...a: unknown[]) => Promise<unknown>)
      }));
      const judge = mergedOpts.mixtureJudge || this.callChat.bind(this);
      const r = await runMoA(bound, judge as (...a: unknown[]) => Promise<{ content: string }>, input, { ...mergedOpts, _phase: 'mixture' });
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    if (mergedOpts.evolve) {
      const evoOpts = {
        ...mergedOpts,
        popSize: mergedOpts.evolvePop || 10,
        generations: mergedOpts.evolveGenerations || 6,
        runId: mergedOpts.evolveRunId || undefined
      };
      const evo = await evolvePrompts(this.callChat.bind(this), evoOpts as Parameters<typeof evolvePrompts>[1]);
      if (mergedOpts.evolveOnly) return evo;
      const sys = evo.best.systemPrompt;
      const r = await applyEvolvedPrompt(this.callChat.bind(this), sys, input, mergedOpts);
      return parseDataType(r, type !== 'string' ? type : 'string');
    }

    // NOTE: evolvedApply must NOT short-circuit here. it falls through to the
    // pipeline path below which injects the trained prompt as thinking guidance
    // into the FULL pipeline — probes, code, checks, revisions. an early return
    // here turns it into a single raw call with no checks and no format pin
    // (the iqHard evolved run measured 1 call/350 tok, dt 10/20 vs plain 20/20 —
    // a bogus number from exactly this bug).

    if (mergedOpts.tools === true || (mergedOpts.tools && typeof mergedOpts.tools === 'object')) {
      const toolOpts = { ...mergedOpts, tools: Array.isArray(mergedOpts.tools) ? mergedOpts.tools : DEFAULT_TOOLS };
      const r = await toolLoop(this.callChat.bind(this), input, toolOpts as Parameters<typeof toolLoop>[2]);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    if (mergedOpts.planExecute) {
      const r = await runPlanAndExecute(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    if (mergedOpts.debate) {
      const r = await runDebate(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    if (mergedOpts.selfConsistency && (mergedOpts.selfConsistencySamples || 5) >= 2) {
      const r = await selfConsistency(this.callChat.bind(this), input, mergedOpts);
      return parseDataType(r.answer, type !== 'string' ? type : 'string');
    }

    let reflexionCtx: ReturnType<typeof attachReflexion> | null = null;
    if (mergedOpts.reflexion) {
      reflexionCtx = attachReflexion(this.callChat.bind(this), input, mergedOpts);
    }

    const calibrator = mergedOpts.calibrate ? makeCalibrator(mergedOpts._calibration || {}) : null;

    if (mergedOpts.analytical && !mergedOpts._skipAnalytical) {
      const ctx = {
        callChat: this.callChat.bind(this) as (...a: unknown[]) => Promise<{ content: string }>,
        generate: this.generate.bind(this) as (...a: unknown[]) => Promise<unknown>,
        limiter: { run: <T>(fn: () => Promise<T>) => this.limiter.add(fn) }
      };
      return analyzeAndSolve(ctx, input, type, depth, checks, onChunk as ((chunk: string) => void) | null, mergedOpts, 0);
    }

    if (mergedOpts.cognitiveFlow && !mergedOpts._skipCognitiveFlow) {
      const inputText = messagesToText(input);
      const flowResult = await runCognitiveFlow(this.callChat.bind(this) as (...a: unknown[]) => Promise<{ content: string }>, inputText, mergedOpts);

      // answerFormat: 'bracket' — the final answer must land as [value]
      // on the last line, so extractors (benchmark verify, tools) can
      // find it unambiguously instead of guessing at prose.
      const fmtDirective = mergedOpts.answerFormat === 'bracket' && type !== 'json'
        ? ' End with the final answer in square brackets on the last line, e.g. [42]. Nothing after the closing bracket.'
        : /ANSWER\s*:/.test(typeof mergedOpts.systemPrompt === 'string' ? mergedOpts.systemPrompt : '')
          ? ' End with the final answer on a line starting with "ANSWER: ". If the problem lists numbered choices, answer with the choice NUMBER only (e.g. "ANSWER: 3" for choice 3) — never the value itself. Nothing after that line.'
          : '';
      const preFinal: ChatMessage[] = [
        { role: 'system', content: `Extract the final verified answer from this cognitive process log. Match the requested data type: ${mergedOpts.type}. Output ONLY the final answer.${fmtDirective}` },
        { role: 'user', content: flowResult }
      ];

      const isStream = typeof mergedOpts.onChunk === 'function';
      const finalSamplingProfile = mergedOpts.samplingProfile || (type !== 'string' ? 'verify' : 'creative');

      if (isStream) mergedOpts.onChunk!('\n\n=== [FINAL SYNTHESIS] ===\n\n', { kind: 'content' });

      const result = await this.callChat(preFinal, isStream, mergedOpts.onChunk || null, { ...mergedOpts, samplingProfile: finalSamplingProfile, think: mergedOpts.depth! > 0, _phase: 'final', _depth: 2 });

      const rawText = stripThinkBlocks(result.content || '');
      return parseDataType(rawText, type !== 'string' ? type : 'string');
    }

    const baseMessages = this.normalizeMessages(input, mergedOpts);
    const inputText = messagesToText(input);
    if (brain) brain.add('input', inputText, 9);
    let finalMessages = baseMessages.map(cloneMessage as (m: ChatMessage) => ChatMessage);
    // evolvedApply in the FULL pipeline: the trained prompt rides as thinking
    // guidance for the final answer (and every check-loop revision), instead
    // of short-circuiting to a plain-mode answer. injection happens AFTER the
    // think-context dump so the merged system message reads:
    //   [format pin] [evolved guidance] [background thinking] [persona]
    // directives front-loaded, background context trailing — the trained
    // prompt frames the reasoning instead of drowning in thinkCtx.
    let evolvedGuide = '';
    if (mergedOpts.evolvedApply) {
      try {
        const best = loadBest(mergedOpts.evolvedApply);
        evolvedGuide = best.systemPrompt;
        this._log('info', 'evolved', `evolvedApply: ${best.id} (fitness ${(best.fitness ?? 0).toFixed(3)}) injected into pipeline`);
      } catch (e) {
        this._log('warn', 'evolved', `evolvedApply failed: ${(e as Error).message}`);
      }
    }
    if (mergedOpts.images && Array.isArray(mergedOpts.images)) {
      const lastUserMsg = finalMessages.slice().reverse().find(m => m.role === 'user');
      const images = await loadImages(mergedOpts.images);
      // text-only model fallback: describe with a vision model, inject as text
      const wantDescribe = mergedOpts.describeImages === true
        || (mergedOpts.visionModel && !looksVisionCapable(this.model));
      if (wantDescribe && images.length) {
        this._log('info', 'images', `describing ${images.length} image(s) via vision model — main model is text-only`);
        const desc = await describeImages(this.callChat.bind(this), images, mergedOpts);
        const imgNote = `\n\n[ATTACHED IMAGE${images.length > 1 ? 'S' : ''} — DESCRIBED BY VISION MODEL]\n${desc}\n[/END IMAGE DESCRIPTION]`;
        if (lastUserMsg) lastUserMsg.content += imgNote;
        else finalMessages.push({ role: 'user', content: 'Attached image.' + imgNote });
      } else if (images.length) {
        if (lastUserMsg) {
          lastUserMsg.images = images;
        } else {
          finalMessages.push({ role: 'user', content: 'Attached image.', images });
        }
      }
    }
    let thinkCtxMsg: ChatMessage | null = null;
    let probeConsensus: string | null = null;
    let probeAgreement = 0;
    // probe consensus is trusted ONLY when an external grader verified the
    // winner's reasoning. confidently-wrong probes share one error, and the
    // old code let a wrong consensus both anchor the final call AND skip the
    // consistency sample — double blind spot.
    let probeConsensusTrusted = true;
    let codeRes: { codeExec: any; sandboxPrefix: ChatMessage[]; failInsert: string | null } | null = null;
    if (depth > 0) {
      // the trained prompt ALSO rides into the probes themselves: they are
      // the deep-think engine, and the evolved techniques (poincare-incubate,
      // mid-flight-reconsider...) are exactly the reasoning moves the probes
      // should make. probe framing lives in think.ts via opts.evolvedGuide.
      const thinkOpts = { ...mergedOpts, _phase: 'think', _depth: 2 };
      if (evolvedGuide) thinkOpts.evolvedGuide = evolvedGuide;
      // conditional probes: code when computational, constraint/analogy when
      // hard — the difficulty router also drives budget forcing below.
      // code probe only at depth 3: at depth 2 the sandbox path already
      // computes the answer for real, so a "what would the code output"
      // guess probe is redundant (and its text is the longest in the dump).
      thinkOpts.codeProbe = looksComputational(inputText) && (depth >= 3);
      thinkOpts.hard = estimateDifficulty(inputText, depth);
      // probe wave and sandbox chain are fully independent — run them
      // concurrently (runThink fires 3-10 probe calls while detectComputeNeeds
      // + codegen fire 2-8 more; the old code ran all of those serially).
      const thinkTask = (async () => {
        const thinkResults = await runThink(this.callChat.bind(this) as (...a: unknown[]) => Promise<{ content: string }>, inputText, depth, thinkOpts);
        probeConsensus = thinkResults.consensus ?? null;
        probeAgreement = thinkResults.agreement ?? 0;
        // external step-grader on the consensus (cheap PRM): the probes self-
        // report confidence, and confident probes can share ONE error. a fast
        // grader scores the winner's actual reasoning; a flawed winner gets
        // red-flagged so the final call re-derives instead of rubber-stamping.
        // sound winner → trust it, and keep skipping the redundant consistency
        // call. only the consensus path grades — the synthesis path already
        // re-examined every probe.
        probeConsensusTrusted = !!probeConsensus;
        if (probeConsensus && thinkResults.consensusText) {
          try {
            const verdict = await this.callChat(
              [
                { role: 'system', content: 'You are a step-level math grader. Score each step of the reasoning 0.0-1.0 and judge whether the conclusion follows from the steps. Output ONLY JSON: {"total": 0.0-1.0, "flaw": "specific error, or empty string", "verdict": "SOUND"|"FLAWED"}' },
                { role: 'user', content: `Problem:\n${inputText}\n\nSolution attempt:\n${compressProbeDump(thinkResults.consensusText)}\n\n` }
              ],
              false, null,
              { ...mergedOpts, think: false, autoSystemPrompt: false, samplingProfile: 'verify', _phase: 'probe_verdict', _depth: 1, options: { ...(mergedOpts.options || {}), temperature: 0.2, num_predict: 250 } }
            );
            const vj = extractJSON(verdict.content || '') as Record<string, unknown>;
            const total = Number(vj?.total ?? NaN);
            const flaw = String(vj?.flaw || '').trim();
            const sound = isFinite(total) && total >= 0.6 && String(vj?.verdict).toUpperCase() !== 'FLAWED';
            probeConsensusTrusted = sound;
            this._log('info', 'probe_verdict', `consensus [${probeConsensus}] → ${sound ? `SOUND (${total.toFixed(2)})` : `FLAWED (${total.toFixed(2)})${flaw ? ' — ' + flaw : ''}`}`);
            if (brain) brain.add('probe_verdict', `${sound ? 'SOUND' : 'FLAWED'} ${total.toFixed(2)}`, 8);
          } catch (e) {
            // grader error = no evidence of a flaw → keep trusting the consensus
            this._log('warn', 'probe_verdict', `grader failed: ${(e as Error).message}`);
          }
        }
        if (brain) brain.add('think_stages', Object.keys(thinkResults).join(', '), 6);
        return thinkResults;
      })();

      const codeTask = (async (): Promise<{ codeExec: typeof codeExec; sandboxPrefix: ChatMessage[]; failInsert: string | null } | null> => {
        if (mergedOpts.enableCode === false) return null;
        // skip the compute-detection LLM call for inputs with no arithmetic
        // or computation vocabulary — pure reasoning stays pure.
        if (!looksComputational(inputText)) {
          this._log('info', 'compute', 'input has no computational markers — skipping compute detection');
          return null;
        }
        const needs = await this.detectComputeNeeds(input, mergedOpts);
        const codeOpts = { ...mergedOpts, _phase: 'codegen' };
        const callCode = (task: string) => generateAndRunCode(this.callChat.bind(this) as (...a: unknown[]) => Promise<{ content: string }>, task, inputText, codeOpts);
        if (reflexionCtx) {
          const hint = await reflexionCtx.getHint();
          if (hint) mergedOpts.systemPrompt = (mergedOpts.systemPrompt || '') + '\n\n' + hint;
        }
        if (needs.mode === 'parallel') {
          try {
            const results = await Promise.all(needs.tasks!.map(t => this.limiter.add(() => callCode(t))));
            const combined = results.map((r, i) => `Task ${i + 1}: ${needs.tasks![i]}\nResult: ${r.result}`).join('\n\n');
            // a parallel batch is validated only if EVERY subtask was
            // independently cross-validated; one weak link poisons the lot.
            const allValidated = results.every(r => r.sandboxValidated);
            return {
              codeExec: { result: results.map(r => r.result).join(' | '), sandboxValidated: allValidated },
              sandboxPrefix: [{ role: 'system', content: (allValidated ? sandbox : '<<<SANDBOX_CANDIDATE>>>\n') + `PARALLEL SANDBOX RESULTS${combined}\n\n${allValidated ? 'These values are cross-validated. Do NOT contradict them.' : 'Treat these as candidate results — verify before finalizing.'}` }],
              failInsert: null
            };
          } catch (e: unknown) {
            return { codeExec: null, sandboxPrefix: [], failInsert: `PARALLEL CODE FAILED: ${(e as Error).message}. Use reasoning.` };
          }
        }
        if (needs.mode === 'single' && needs.task) {
          try {
            const codeExec = await callCode(needs.task);
            if (brain) brain.add('code_result', `${needs.task} = ${codeExec.result}`, 10);
            const validated = !!codeExec.sandboxValidated;
            const mcts = codeExec.mctsConsensus as { count?: number } | null | undefined;
            let trustLine: string;
            if (validated) {
              trustLine = 'This value is cross-validated by independent implementations. Your answer MUST state [' + codeExec.result + '] exactly.';
            } else if (mcts && (mcts.count || 0) >= 2) {
              // 2+ independent implementations agree — a strong signal, not a
              // lone guess. the old "one implementation" framing made the
              // final call re-derive by hand and introduced errors (a26i-09).
              trustLine = `${mcts.count} independent implementations agree on [${codeExec.result}]. Treat it as the leading candidate — verify the reasoning, but do NOT discard it without cause.`;
            } else if (codeExec.disagreement) {
              // JS and Python ran but disagree — one is wrong. the final call
              // must see BOTH values and the conflict, not one side picked
              // arbitrarily (g03: JS 4 correct, PY 20 wrong — presenting PY's
              // 20 alone made the hand-derivation fail).
              trustLine = `JS and Python disagree (JS: ${codeExec.disagreement.js}, PY: ${codeExec.disagreement.py}) — at most one is right. Re-derive carefully; do not trust either blindly.`;
            } else {
              trustLine = 'This is a candidate result from one implementation — independently verify it before finalizing.';
            }
            // AIME-style problems ask for integers; a non-integer sandbox
            // result means the code is wrong, not the answer. flag it so the
            // final call re-derives instead of rubber-stamping garbage
            // (a26ii-02: DP returned 90.1 for a √N problem).
            const res = String(codeExec.result || '').trim();
            if (!/^-?\d+$/.test(res) && /find (the )?(number|sum|value|integer|smallest|largest)|m ?\+ ?n|how many|√|sqrt|find the number of ways/i.test(inputText)) {
              trustLine += ` The sandbox result [${res}] is NOT an integer, but this problem asks for an integer — the code is likely wrong. Re-derive the answer yourself.`;
            }
            return {
              codeExec,
              sandboxPrefix: [{
                role: 'system',
                content: (validated ? sandbox : '<<<SANDBOX_CANDIDATE>>>\n') + `SANDBOX RESULT\nTask:${needs.task}\nResult: ${codeExec.result}\n\n` + trustLine,
              }],
              failInsert: null
            };
          } catch (e: unknown) {
            return { codeExec: null, sandboxPrefix: [], failInsert: `CODE FAILED: ${(e as Error).message}. Use reasoning.` };
          }
        }
        return null;
      })();

      const [thinkResults, codeResolved] = await Promise.all([thinkTask, codeTask]);
      codeRes = codeResolved;
      let thinkCtx = 'BACKGROUND THINKING PROCESS (do not repeat this in your answer):\n';
      for (const [k, v] of Object.entries(thinkResults)) {
        // consensusText duplicates the winning probe already in analysis —
        // sending both is pure token waste
        if (k === 'consensusText') continue;
        if (v && typeof v === 'string') thinkCtx += `\n[${k.toUpperCase()}]\n${compressProbeDump(v)}\n`;
      }
      // probe consensus: N independent passes landed on the same value —
      // the strongest self-consistency signal the pipeline has. the final
      // call must treat it as the leading candidate, not ignore it — UNLESS
      // the external step-grader found a flaw in the winner's reasoning, in
      // which case the probes likely share one error and re-derivation is
      // the only honest move.
      if (probeConsensus) {
        thinkCtx += probeConsensusTrusted
          ? `\nPROBE CONSENSUS: ${Math.round(probeAgreement * 100)}% of independent probes arrived at [${probeConsensus}], and an external step-level grader confirmed their reasoning is sound. Treat this as the leading candidate — verify it, do not ignore it.\n`
          : `\nPROBE CONSENSUS: ${Math.round(probeAgreement * 100)}% of probes arrived at [${probeConsensus}], BUT external step-scoring found a flaw in their shared reasoning. The probes may repeat ONE error. Re-derive from scratch — do NOT assume [${probeConsensus}].\n`;
      }
      if (brain) {
        await this.consolidateBrainMemory(brain, mergedOpts);
        const bc = brain.getContextBlock();
        if (bc) thinkCtx = bc + '\n\n' + thinkCtx;
      }
      thinkCtxMsg = { role: 'system', content: thinkCtx };
      finalMessages = insertSystemPrompt(finalMessages, thinkCtx);
    }
    // evolved guidance sits AFTER thinkCtx in the stack but consolidates
    // BEFORE it (consolidateSystemMessages merges system msgs in array
    // order), so the merged system message ends up:
    //   [pin] [evolved] [thinkCtx] [persona...]
    if (evolvedGuide) finalMessages = insertSystemPrompt(finalMessages, evolvedGuide);
    let codeExec: { result: string; sandboxValidated?: boolean; disagreement?: { js: string; py: string } | null } | null = null;
    let sandboxPrefix: ChatMessage[] = [];
    if (codeRes) {
      codeExec = codeRes.codeExec;
      sandboxPrefix = codeRes.sandboxPrefix;
      if (codeRes.failInsert) finalMessages = insertSystemPrompt(finalMessages, codeRes.failInsert);
    }
    // answerFormat: 'bracket' / "ANSWER: X" — the final answer must land in
    // the requested shape. rides in the system messages so every revision
    // pass keeps seeing it. if the problem lists numbered choices, the
    // answer must be the choice NUMBER, not the value — models otherwise
    // write "ANSWER: 31" when the gold is the index "3".
    const fmtDirective = buildFormatDirective(mergedOpts, type);
    if (fmtDirective) finalMessages = insertSystemPrompt(finalMessages, fmtDirective);
    const preFinal = consolidateSystemMessages(finalMessages);
    // budget forcing (s1 recipe): hard problems get "Wait. Let me reconsider
    // this step by step." appended — forces re-examination before the final
    // answer. never applied to easy problems (tiny budgets beat full thinking
    // on shallow tasks).
    const hard = estimateDifficulty(inputText, depth);
    if (hard) {
      const lastUser = [...preFinal].reverse().find(m => m.role === 'user');
      if (lastUser) lastUser.content += '\n\nWait. Let me reconsider this step by step.';
    }
    // edge-case enumeration for "find all" / "determine all" problems —
    // forces explicit check of boundary values (n=0, n=1, extremes) before
    // the final answer. proof problems often miss edge cases.
    if (/find all|determine all|for all n ≥|for every integer/i.test(inputText)) {
      const lastUser = [...preFinal].reverse().find(m => m.role === 'user');
      if (lastUser) lastUser.content += '\n\nBefore finalizing, explicitly list ALL edge cases and boundary values you checked (n=0, n=1, small n, large n, extremes). Verify the result holds for each.';
    }
    const isStream = typeof onChunk === 'function';
    const finalSamplingProfile = mergedOpts.samplingProfile || (type !== 'string' ? 'verify' : 'creative');
    let result = await this.callChat([...sandboxPrefix, ...preFinal], isStream, onChunk, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'final', _depth: 2 });
    let rawText = stripThinkBlocks(result.content || '');
    // truncation recovery: a cut-off proof is worse than no answer. retry
    // once with a bigger budget and a finish directive before the checkers
    // ever see the fragment.
    if (looksTruncated(rawText)) {
      this.emit('log', { level: 'warn', msg: `[FINAL] response looks truncated (${rawText.length}ch) — retrying with finish directive`, source: 'final', ts: Date.now() });
      // recovery budget must EXCEED the original — a cut-off proof needs room
      // to finish, and the directive forces a conclusion so even a partial
      // proof still lands the answer.
      const finishMsg = { role: 'user', content: `Your previous response was cut off mid-sentence:\n\n"""${rawText.slice(-800)}"""\n\nState the final conclusion in one sentence, then complete the proof concisely. If the full proof is too long, give the conclusion and the key argument.` };
      result = await this.callChat([...sandboxPrefix, ...preFinal, finishMsg], isStream, isStream ? onChunk : null, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'final', _depth: 2, options: { ...(mergedOpts.options || {}), num_predict: 2500 } });
      rawText = stripThinkBlocks(result.content || '');
    }
    if (codeExec?.sandboxValidated) {
      const gt = String(codeExec.result).trim();
      // always stamp — the machine-verified value is ground truth even when
      // the model already wrote it mid-reasoning (the extractor keys on the
      // stamp; a bare mention in prose is not an answer, and the last-number
      // rule then grabs whatever trailing number the prose ends on)
      if (gt) rawText += `\n\n**Verified Answer: ${gt}**`;
    }
    if (brain) brain.add('first_response', rawText, 6);

    if (checks > 0) {
      const maxIter = mergedOpts.maxCheckIterations ?? 10;
      const gt = codeExec ? { value: codeExec.result, sandboxValidated: !!codeExec.sandboxValidated } : null;
      const monitor = new Metacognitive({
        windowSize: mergedOpts.monitorWindowSize ?? 5,
        emit: (e, p) => this.emit(e, p)
      });
      monitor.updateBest(rawText, 0);
      let convo: ChatMessage[] = [...preFinal.filter(m => m.role !== 'system'), { role: 'assistant', content: rawText }];
      let prevVerdicts = '';
      let stallIter = 0;
      let bestPassed = 0;
      // commitment boundary: the answer value of the first draft — if a
      // revision produces the same value, the answer has stabilized.
      let prevAnswer = normAnswer(extractAnswerValue(rawText));
      for (let iter = 0; iter < maxIter; iter++) {
        const checkResults = await this.runChecks(input, rawText, checks, mergedOpts, gt, sandboxPrefix);
        const passed = checkResults.filter(r => r.correct).length;
        monitor.updateBest(rawText, passed);
        const failed = checkResults.filter(r => !r.correct);
        if (!failed.length) break;
        // verdict-pattern escape: same Y/N pattern twice in a row = the
        // revision isn't converging (feedback wording churns, verdicts
        // don't). stop burning tokens, return the best-scoring draft.
        const verdicts = checkResults.map(r => (r.correct ? 'Y' : 'N')).join('');
        if (verdicts === prevVerdicts) {
          this.emit('log', { level: 'warn', msg: `[CHECK LOOP] verdict pattern ${verdicts} repeated at iter ${iter} — revision not converging, stopping.`, source: 'checks', ts: Date.now() });
          rawText = monitor.interrupt(rawText);
          break;
        }
        prevVerdicts = verdicts;
        // no-progress escape: verdicts keep churning but the passed count
        // never improves across 3 revisions — more revising won't help.
        if (passed > bestPassed) { bestPassed = passed; stallIter = 0; } else if (++stallIter >= 3) {
          this.emit('log', { level: 'warn', msg: `[CHECK LOOP] no improvement in ${stallIter} revisions (best ${bestPassed}/${checks}) — stopping.`, source: 'checks', ts: Date.now() });
          rawText = monitor.interrupt(rawText);
          break;
        }
        if (monitor.trackFeedback(failed)) {
          rawText = monitor.interrupt(rawText);
          break;
        }
        if (monitor.trackResponse(rawText)) {
          rawText = monitor.interrupt(rawText);
          break;
        }
        const gtReminder = gt?.sandboxValidated ? `GROUND TRUTH: The answer is [${gt.value}]. Do not recalculate.` : '';
        const feedback = `${failed.length}/${checks} checker(s) found issues:\n` + [...new Set(failed.map(f => f.feedback).filter(Boolean) as string[])].map((f, i) => `• ${i + 1}: ${f}`).join('\n') + gtReminder + '\n\nRevise your response to address all issues.';
        const lastIsFeedback = convo.at(-1)?.role === 'user' && convo.at(-1)!.content.includes('checker(s) found issues');
        convo = lastIsFeedback ? [...convo.slice(0, -1), { role: 'user', content: feedback }] : [...convo, { role: 'user', content: feedback }];
        const isLast = iter === maxIter - 1;
        // proofs need room: 400 tokens fits a short answer, not a Putnam
        // proof. scale the revise budget to the draft it must fix.
        const reviseBudget = rawText.length > 600 ? 2000 : 400;
        result = await this.callChat([...sandboxPrefix, ...consolidateSystemMessages([...preFinal.filter(m => m.role === 'system'), ...convo])], isStream && isLast, isStream && isLast ? onChunk : null, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'revise', _depth: 3, options: { ...(mergedOpts.options || {}), num_predict: reviseBudget } });
        rawText = stripThinkBlocks(result.content || '');
        // truncation recovery inside the loop: a revise that cuts off
        // mid-proof gets one more shot with a finish directive.
        if (looksTruncated(rawText)) {
          this.emit('log', { level: 'warn', msg: `[CHECK LOOP] revise truncated (${rawText.length}ch) — retrying with finish directive`, source: 'checks', ts: Date.now() });
          const finishMsg = { role: 'user', content: `Your previous response was cut off mid-sentence:\n\n"""${rawText.slice(-800)}"""\n\nState the final conclusion in one sentence, then complete the proof concisely. If the full proof is too long, give the conclusion and the key argument.` };
          result = await this.callChat([...sandboxPrefix, ...consolidateSystemMessages([...preFinal.filter(m => m.role === 'system'), ...convo, finishMsg])], isStream && isLast, isStream && isLast ? onChunk : null, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'revise', _depth: 3, options: { ...(mergedOpts.options || {}), num_predict: 2500 } });
          rawText = stripThinkBlocks(result.content || '');
        }
        if (codeExec?.sandboxValidated) {
          const gtv = String(codeExec.result).trim();
          if (gtv) rawText += `\n\n**Verified Answer: ${gtv}**`;
        }
        // commitment-boundary escape: the answer value stopped changing
        // across revisions — it has stabilized, more revising just churns
        // tokens (research: answers stabilize mid-trace; stopping once the
        // value is unchanged cuts CoT up to 55% with negligible loss).
        const curAnswer = normAnswer(extractAnswerValue(rawText));
        if (curAnswer && curAnswer === prevAnswer) {
          this.emit('log', { level: 'warn', msg: `[CHECK LOOP] answer stabilized at [${curAnswer}] — commitment boundary reached, stopping.`, source: 'checks', ts: Date.now() });
          rawText = monitor.interrupt(rawText);
          break;
        }
        prevAnswer = curAnswer;
        convo = [...convo, { role: 'assistant', content: rawText }];
      }
      // final self-consistency: one independent blind re-derivation of the
      // answer. the checkers audit the draft and can be anchored to its
      // reasoning; a fresh sample from the ORIGINAL input only catches
      // "confident but wrong" answers the checkers rubber-stamp. on
      // mismatch, reconcile once and re-check. skipped when the sandbox
      // already machine-verified the answer (machine > model sample) or
      // when the probes already agreed AND an external grader verified the
      // winner's reasoning (agreement IS the consistency signal — a second
      // sample adds nothing). an unverified or flawed consensus does NOT
      // skip the sample.
      if (mergedOpts.finalConsistency !== false && !codeExec?.sandboxValidated && !probeConsensusTrusted) {
        const fmtDir = buildFormatDirective(mergedOpts, type);
        const mine = extractAnswerValue(rawText);
        if (fmtDir && mine && mine.length <= 60) {
          try {
            const indep = await this.callChat(
              [{ role: 'system', content: `Solve the problem independently from scratch. Do not assume any prior work exists. ${fmtDir}` }, { role: 'user', content: inputText }],
              false, null, { ...mergedOpts, think: true, samplingProfile: 'verify', _phase: 'consistency', _depth: 2, options: { ...(mergedOpts.options || {}), num_predict: 300 } }
            );
            const theirs = extractAnswerValue(stripThinkBlocks(indep.content || ''));
            if (theirs && normAnswer(theirs) !== normAnswer(mine)) {
              this.emit('log', { level: 'warn', msg: `[SELF-CONSISTENCY] independent re-derivation [${theirs}] ≠ pipeline [${mine}] — reconciling`, source: 'checks', ts: Date.now() });
              const reconcileMsg = `An independent re-derivation of the problem produced the answer [${theirs}], but your answer is [${mine}]. At most one is right. Re-derive carefully, find the error, and give the final answer.`;
              convo = [...convo, { role: 'user', content: reconcileMsg }];
              result = await this.callChat([...sandboxPrefix, ...consolidateSystemMessages([...preFinal.filter(m => m.role === 'system'), ...convo])], isStream, isStream ? onChunk : null, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'revise', _depth: 3, options: { ...(mergedOpts.options || {}), num_predict: rawText.length > 600 ? 2000 : 400 } });
              rawText = stripThinkBlocks(result.content || '');
              if (looksTruncated(rawText)) {
                const finishMsg = { role: 'user', content: `Your previous response was cut off mid-sentence:\n\n"""${rawText.slice(-800)}"""\n\nState the final conclusion in one sentence, then complete the proof concisely. If the full proof is too long, give the conclusion and the key argument.` };
                result = await this.callChat([...sandboxPrefix, ...consolidateSystemMessages([...preFinal.filter(m => m.role === 'system'), ...convo, finishMsg])], isStream, isStream ? onChunk : null, { ...mergedOpts, samplingProfile: finalSamplingProfile, _phase: 'revise', _depth: 3, options: { ...(mergedOpts.options || {}), num_predict: 2500 } });
                rawText = stripThinkBlocks(result.content || '');
              }
              const recheck = await this.runChecks(input, rawText, checks, mergedOpts, gt, sandboxPrefix);
              const passed2 = recheck.filter(r => r.correct).length;
              this.emit('log', { level: 'info', msg: `[SELF-CONSISTENCY] reconciled answer passed ${passed2}/${checks} checks`, source: 'checks', ts: Date.now() });
            } else {
              this.emit('log', { level: 'info', msg: `[SELF-CONSISTENCY] independent re-derivation confirmed [${theirs}]`, source: 'checks', ts: Date.now() });
            }
          } catch (e) {
            this.emit('log', { level: 'warn', msg: `[SELF-CONSISTENCY] sample failed: ${(e as Error).message}`, source: 'checks', ts: Date.now() });
          }
        }
      }
    }
    if (brain) brain.add('final_response', rawText, 9);

    if (Array.isArray(mergedOpts._compressMessages)) {
      mergedOpts._compressMessages = await compress(this.callChat.bind(this) as (...a: unknown[]) => Promise<{ content: string }>, mergedOpts._compressMessages, mergedOpts);
    } else if (Array.isArray(mergedOpts._truncatableMessages) && mergedOpts._truncatableMessages.length > 12) {
      mergedOpts._truncatableMessages = truncateMiddle(mergedOpts._truncatableMessages, 4, 8);
    }

    if (calibrator) {
      const truth = mergedOpts._groundTruth;
      if (truth !== undefined) {
        const passed = String(parseDataType(rawText, type !== 'string' ? type : 'string')) === String(truth);
        calibrator.record(type, passed);
      }
    }

    if (reflexionCtx && mergedOpts._lastResultFailed) {
      try { await reflexionCtx.learn(mergedOpts._lastResultFailed); } catch { /* swallow */ }
    }

    let finalOutput = parseDataType(rawText, type !== 'string' ? type : 'string');
    if (mergedOpts.ollamaOutput) {
      finalOutput = result.thinking ? ` thinking\n${result.thinking}\n response\n\n${rawText}` : rawText;
    }
    return finalOutput;
  }
}

Deepthink.BrainMemory = Brain;
Deepthink.MetacognitiveMonitor = Metacognitive;
Deepthink.AsyncMutex = Async;
Deepthink.compareResults = compareResults;
Deepthink.PYTHON_BIN = PYTHON_BIN;
Deepthink.SANDBOX_GT_SENTINEL = sandbox;
Deepthink.SAMPLING = SAMPLING;
Deepthink.QWEN_DEFAULTS = qwen;

export default Deepthink;
