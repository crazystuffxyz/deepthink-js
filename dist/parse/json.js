import { stripCodeFences, stripThinkBlocks } from '../thinking/dataTypes.js';
export function extractJsonCandidate(text) {
    if (!text)
        return null;
    const clean = stripThinkBlocks(text);
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) {
        const inner = fence[1].trim();
        if (inner.startsWith('{') || inner.startsWith('['))
            return inner;
    }
    const firstBrace = clean.indexOf('{');
    const firstBracket = clean.indexOf('[');
    let start = -1;
    if (firstBrace === -1)
        start = firstBracket;
    else if (firstBracket === -1)
        start = firstBrace;
    else
        start = Math.min(firstBrace, firstBracket);
    if (start === -1)
        return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < clean.length; i++) {
        const c = clean[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (c === '\\')
                esc = true;
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"')
            inStr = true;
        else if (c === '{' || c === '[')
            depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0)
                return clean.substring(start, i + 1);
        }
    }
    return null;
}
// LLM LaTeX leaks into JSON strings: \mu, \sigma, \sqrt are invalid JSON
// escapes and JSON.parse throws "Bad escaped character" (run 18: the math
// critic quoted the report's formulas). a run of backslashes before a
// non-escape char must be EVEN (each pair = one literal backslash); odd
// runs get one more backslash. already-escaped runs (\\sigma) stay put.
function repairBadEscapes(s) {
    return s.replace(/(\\+)(?![\\"\/bfnrtu]|u[0-9a-fA-F]{4})/g, (m) => m + (m.length % 2 ? '\\' : ''));
}
// {"issues": [a], b, c] — the model closed the array early and appended the
// remaining issues as sibling objects, then closed with the array's bracket.
// fold the trailing objects back into the array. only matches strings that
// END with ] (valid JSON ends with }), so it can't corrupt valid output.
function repairEscapedArrayObjects(s) {
    const m = s.match(/^(\{[\s\S]*?"issues":\s*\[)([\s\S]*?)(\])((?:,\s*\{[\s\S]*?\})*)\]$/);
    if (!m)
        return null;
    const [, head, inner, , tail] = m;
    const folded = tail.replace(/^,\s*/, '');
    return `${head}${inner}${folded ? ',' + folded : ''}]}`;
}
export function parseJsonSafe(text, schema) {
    const candidate = extractJsonCandidate(text ?? '');
    if (candidate == null) {
        return {
            ok: false,
            error: new Error('no JSON candidate found in input'),
            raw: String(text ?? '')
        };
    }
    let raw;
    try {
        raw = JSON.parse(candidate);
    }
    catch (e) {
        // repair chain: bad escapes first (most common), then escaped-array
        // objects, then the legacy fence strip
        const repaired = repairBadEscapes(candidate);
        try {
            raw = JSON.parse(repaired);
        }
        catch (e2) {
            const repaired2 = repairEscapedArrayObjects(repaired) ?? repaired;
            try {
                raw = JSON.parse(repaired2);
            }
            catch (e3) {
                const cleaned = stripCodeFences(candidate);
                try {
                    raw = JSON.parse(cleaned);
                }
                catch (e4) {
                    return {
                        ok: false,
                        error: e4 instanceof Error ? e4 : new Error('JSON.parse failed'),
                        raw: candidate
                    };
                }
            }
        }
    }
    const result = schema.safeParse(raw);
    if (result.success)
        return { ok: true, data: result.data };
    return { ok: false, error: result.error, raw: candidate };
}
export function tryParseJsonSafe(text, schema) {
    const r = parseJsonSafe(text, schema);
    return r.ok ? r.data : null;
}
