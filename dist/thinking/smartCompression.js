// thinking/smartCompression.ts
import { stripThinkBlocks } from './dataTypes.js';
export function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}
export function totalTokens(messages) {
    let n = 0;
    for (const m of messages)
        n += approxTokens(m.content);
    return n;
}
function oldestSystem(messages) {
    return messages.findIndex(m => m.role !== 'system');
}
export async function compress(callChat, messages, opts = {}) {
    const max = opts.maxTokens || 6000;
    if (totalTokens(messages) <= max)
        return messages;
    const cutAt = Math.max(0, oldestSystem(messages) + 1);
    const head = messages.slice(0, cutAt);
    const middle = messages.slice(cutAt, -2);
    const tail = messages.slice(-2);
    if (!middle.length)
        return messages;
    const blob = middle.map((m, i) => `[${m.role.toUpperCase()} ${i + 1}]\n${m.content}`).join('\n\n');
    const r = await callChat([
        {
            role: 'system',
            content: 'Compress the following conversation excerpt into the smallest set of facts that ' +
                'preserves decisions, constraints, numbers, and named entities. Drop filler and ' +
                'redundancy. Output plain text only — no labels, no markdown.'
        },
        { role: 'user', content: blob }
    ], false, null, { ...opts, think: false, autoSystemPrompt: false, samplingProfile: 'reasoning' });
    const summary = stripThinkBlocks(r.content || '').trim();
    if (!summary)
        return messages;
    return [...head, { role: 'system', content: `[COMPRESSED CONTEXT]\n${summary}` }, ...tail];
}
export function truncateMiddle(messages, keepFirst = 4, keepLast = 8) {
    if (messages.length <= keepFirst + keepLast)
        return messages;
    return [
        ...messages.slice(0, keepFirst),
        { role: 'system', content: `[... ${messages.length - keepFirst - keepLast} earlier messages truncated ...]` },
        ...messages.slice(-keepLast)
    ];
}
