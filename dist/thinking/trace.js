// thinking/trace.ts
// call-audit trail for every LLM call deepthink-js makes.
//
// Each callChat() gets recorded as a TraceEvent with a sequential id,
// a parent scope id, depth, phase, model, full prompt + response,
// latency, tokens, status and the concurrency level at call time.
//
// The store is the single source of truth; the <thinking> XML blocks
// are just formatters over it, so nothing in the pipeline ever
// string-concatenates reasoning text by hand.
//
// Modes:
//   off          — record nothing (zero overhead)
//   flat         — one big <thinking>...</thinking> block with every
//                  call's prompt+response inside (the default)
//   hierarchical — nested <thinking depth="N"> blocks per scope
//   calls        — one <thinking callId=".."> block per LLM call
//
// export { TraceStore, TraceEvent, TraceMode };
/**
 * TraceStore — append-only record of LLM calls. Scopes model the
 * pipeline hierarchy (generate -> think -> final), so parallel calls
 * inside one scope share a parent and keep deterministic ids.
 */
export class TraceStore {
    events = [];
    mode;
    maxEvents; // memory guard; overflow drops oldest
    dropped = 0;
    nextCallId = 1;
    nextScopeId = 1;
    scopes = [];
    startedAt = 0;
    constructor(mode = 'flat', maxEvents = 500) {
        this.mode = mode;
        this.maxEvents = maxEvents;
    }
    get depth() {
        return this.scopes.length ? this.scopes[this.scopes.length - 1].depth : 0;
    }
    get parentCallId() {
        return this.scopes.length ? this.scopes[this.scopes.length - 1].id : null;
    }
    /** push a pipeline scope; returns a handle for pop() */
    pushScope(phase, depthOffset = 0) {
        const depth = this.depth + 1 + depthOffset;
        const id = this.nextScopeId++;
        this.scopes.push({ id, phase, depth });
        return id;
    }
    popScope() {
        this.scopes.pop();
    }
    markStart() {
        this.startedAt = Date.now();
    }
    begin(opts) {
        const id = this.nextCallId++;
        this.events.push({
            callId: id,
            parentCallId: opts.parentCallId !== undefined ? opts.parentCallId : this.parentCallId,
            depth: opts.depth !== undefined ? opts.depth : this.depth,
            ts: Date.now(),
            model: opts.model,
            phase: opts.phase,
            prompt: opts.prompt,
            response: '',
            latencyMs: 0,
            promptTokens: null,
            responseTokens: null,
            status: 'ok',
            error: null,
            concurrency: opts.concurrency,
        });
        if (this.events.length > this.maxEvents) {
            this.events.shift();
            this.dropped++;
        }
        return id;
    }
    end(callId, patch) {
        const ev = this.events.find((e) => e.callId === callId);
        if (!ev)
            return;
        ev.latencyMs = patch.latencyMs ?? ev.latencyMs;
        ev.response = patch.response ?? ev.response;
        ev.promptTokens = patch.promptTokens ?? ev.promptTokens;
        ev.responseTokens = patch.responseTokens ?? ev.responseTokens;
        ev.status = patch.status ?? ev.status;
        ev.error = patch.error ?? ev.error;
    }
    get size() {
        return this.events.length;
    }
    get durationMs() {
        return this.startedAt ? Date.now() - this.startedAt : 0;
    }
    /** structured export — machine readable, independent of the XML formatters */
    toJSON() {
        return this.events.map((e) => ({ ...e }));
    }
    /** one big <thinking> block containing the entire internal transcript */
    formatFlat() {
        if (!this.events.length)
            return '';
        const parts = this.events.map((e) => {
            const head = `[call #${e.callId} | ${e.phase} | ${e.model} | ${e.latencyMs}ms${e.promptTokens != null ? ' | ' + e.promptTokens + ' in / ' + e.responseTokens + ' out tok' : ''}]`;
            const promptTxt = e.prompt.length > 6000 ? e.prompt.slice(0, 6000) + '\n…[truncated]' : e.prompt;
            const respTxt = e.response.length > 6000 ? e.response.slice(0, 6000) + '\n…[truncated]' : e.response;
            const statusTxt = e.status !== 'ok' ? `\n[status: ${e.status}${e.error ? ' — ' + e.error : ''}]` : '';
            return `${head}\nPROMPT:\n${promptTxt}\n\nRESPONSE:\n${respTxt}${statusTxt}`;
        });
        return `<thinking>\n${parts.join('\n\n---\n\n')}\n</thinking>`;
    }
    /** nested depth-labelled blocks per scope */
    formatHierarchical() {
        if (!this.events.length)
            return '';
        // group events by parentCallId
        const byParent = new Map();
        for (const e of this.events) {
            const k = e.parentCallId;
            if (!byParent.has(k))
                byParent.set(k, []);
            byParent.get(k).push(e);
        }
        const render = (parent, depth) => {
            const kids = byParent.get(parent) || [];
            if (!kids.length)
                return '';
            const inner = kids.map((e) => {
                const block = `<thinking depth="${depth}">\n[call #${e.callId} | ${e.phase} | ${e.model} | ${e.latencyMs}ms]\n` +
                    `PROMPT:\n${e.prompt.slice(0, 2000)}` +
                    `\n\nRESPONSE:\n${e.response.slice(0, 2000)}` +
                    `\n${render(e.callId, depth + 1)}</thinking>`;
                return block;
            });
            return inner.join('\n');
        };
        return render(null, 1);
    }
    /** one block per LLM call, tagged with its id */
    formatCalls() {
        if (!this.events.length)
            return '';
        return this.events
            .map((e) => {
            const tag = e.parentCallId != null ? ` parent="#${e.parentCallId}"` : '';
            return (`<thinking callId="${e.callId}" phase="${e.phase}" depth="${e.depth}"${tag}>\n` +
                `[${e.model} | ${e.latencyMs}ms]\n` +
                `PROMPT:\n${e.prompt.slice(0, 3000)}\n\n` +
                `RESPONSE:\n${e.response.slice(0, 3000)}\n` +
                `</thinking>`);
        })
            .join('\n');
    }
    /** format according to the configured mode */
    format() {
        switch (this.mode) {
            case 'off':
                return '';
            case 'hierarchical':
                return this.formatHierarchical();
            case 'calls':
                return this.formatCalls();
            case 'flat':
            default:
                return this.formatFlat();
        }
    }
    /** human-readable summary line for pipeline end */
    summarize() {
        const total = this.events.length;
        const tokIn = this.events.reduce((a, e) => a + (e.promptTokens ?? 0), 0);
        const tokOut = this.events.reduce((a, e) => a + (e.responseTokens ?? 0), 0);
        const ms = this.events.reduce((a, e) => a + e.latencyMs, 0);
        const errs = this.events.filter((e) => e.status !== 'ok').length;
        const byPhase = new Map();
        for (const e of this.events)
            byPhase.set(e.phase, (byPhase.get(e.phase) || 0) + 1);
        const phaseSummary = [...byPhase.entries()].map(([p, n]) => `${p}×${n}`).join(', ');
        return `trace: ${total} calls, ${tokIn} in / ${tokOut} out tokens, ${(ms / 1000).toFixed(1)}s llm time, ${errs} errors | phases: ${phaseSummary}${this.dropped ? ` | ${this.dropped} dropped (overflow)` : ''}`;
    }
}
