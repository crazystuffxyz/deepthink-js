// thinking/citationIntegrity.ts
// citation preservation for the research pipeline. the report writer and the
// repair agent are *told* to keep [Source N] tags, but telling isn't
// enforcing — this module checks the actual output and repairs it when tags
// go missing, so every verified claim keeps its citation end to end.
import { z } from 'zod';
const TagSchema = z.object({
    tags: z.array(z.string()).optional(),
});
// all [Source N] tags in a text, in order of appearance
export function extractSourceTags(text) {
    const out = [];
    const re = /\[Source\s+(\d+)\]/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        out.push(`[Source ${m[1]}]`);
    }
    return out;
}
// which ref ids are cited at least once, and which tags are orphans
export function checkCitationIntegrity(report, refCount) {
    const cited = new Set();
    const orphans = [];
    const re = /\[Source\s+(\d+)\]/g;
    let m;
    while ((m = re.exec(String(report || ''))) !== null) {
        const id = parseInt(m[1], 10);
        if (id >= 1 && id <= refCount)
            cited.add(id);
        else
            orphans.push(`[Source ${m[1]}]`);
    }
    const missing = [];
    for (let i = 1; i <= refCount; i++) {
        if (!cited.has(i))
            missing.push(i);
    }
    return { cited, missing, orphans };
}
// every reference must appear in the References section, and every cited id
// must have a reference entry
export function checkReferencesSection(report, refCount) {
    const refsSection = String(report || '').split(/## References/i).slice(1).join('## References');
    const missingRefs = [];
    for (let i = 1; i <= refCount; i++) {
        if (!refsSection.includes(`[${i}]`))
            missingRefs.push(i);
    }
    return { missingRefs, ok: missingRefs.length === 0 };
}
// LLM pass: re-insert the missing [Source N] tags at the right places.
// the model sees the report plus the claims each missing source backs, and
// must place the tag where that claim is discussed.
export async function restoreCitations(callChat, report, missingIds, claimsByRef, opts = {}) {
    if (missingIds.length === 0)
        return report;
    const evidence = missingIds.map((id) => {
        const claims = (claimsByRef.get(id) || []).slice(0, 3).map((c) => `  - "${c.slice(0, 200)}"`).join('\n');
        return `[Source ${id}] backs these claims:\n${claims}`;
    }).join('\n\n');
    const r = await callChat([{ role: 'system', content: `You are a citation restorer. The report below lost some of its [Source N] citation tags during editing.

YOUR JOB:
1. Find where each missing source's claims are discussed in the report.
2. Insert the [Source N] tag at that exact spot, inline with the claim (e.g. "Revenue grew 12% [Source 3]").
3. Do NOT change any other text. Do NOT rewrite sentences. Do NOT add or remove content.
4. If a claim genuinely is not in the report, add a short sentence with the claim AND its tag at the most relevant place.

Output ONLY the complete corrected report. No preamble, no explanation.` },
        { role: 'user', content: `MISSING SOURCES:\n${evidence}\n\n---\n\nREPORT:\n${report}` }], false, null, { ...opts, think: false, samplingProfile: 'creative' });
    const restored = (r.content || '').trim();
    if (restored.length < report.length * 0.5)
        return report;
    return restored;
}
// one-shot: check + restore + re-check, returns the final report and what happened
export async function enforceCitations(callChat, report, refCount, claimsByRef, opts = {}) {
    let current = report;
    const { missing, orphans } = checkCitationIntegrity(current, refCount);
    let restored = [];
    if (missing.length) {
        current = await restoreCitations(callChat, current, missing, claimsByRef, opts);
        const after = checkCitationIntegrity(current, refCount);
        restored = missing.filter((id) => !after.missing.includes(id));
        if (after.missing.length) {
            // second attempt with a stricter prompt
            current = await restoreCitations(callChat, current, after.missing, claimsByRef, { ...opts, strict: true });
        }
    }
    return { report: current, restored, orphans };
}
export { TagSchema };
