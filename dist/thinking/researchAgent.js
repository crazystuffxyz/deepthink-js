// thinking/researchAgent.ts
import { marked } from 'marked';
import { getSearchResults, getFetchResults } from '../internet/interactWithInternet.js';
import { extractLocalFile } from '../internet/extractFromUrl.js';
import { generateCitation } from '../internet/extractCitation.js';
import path from 'node:path';
import { runCognitiveFlow } from './cognitive.js';
import { humanizeText } from './humanize.js';
import { runQuantModel } from './quantEngine.js';
import { enforceCitations, checkReferencesSection } from './citationIntegrity.js';
import { tryParseJsonSafe as parseJsonSafe } from '../parse/json.js';
import { z } from 'zod';
import { log } from './events.js';
import { AnswerFormatSpecSchema, PlannerPlanSchema, RankedSchema, ClaimsSchema, VerifyResultSchema, DomainSchema, SourceFidelitySchema, MathLogicSchema, ExpertCritiqueSchema, AdversarialSchema, } from '../parse/llmSchemas.js';
// stock-research mode: the answer spec is fixed so every investment report
// carries the same rigorous skeleton — quant math (Ito/GBM), fundamentals,
// industry status quo, valuation, risks, dated recommendation.
const STOCK_SPEC = {
    answerType: 'recommendation',
    requiredFields: [
        'ticker and company name',
        'current price and the date it was observed',
        'price target with a time horizon',
        'valuation method (DCF, multiples, comparables) with the actual numbers',
        'key financials: revenue, EPS, margins, debt, free cash flow',
        'volatility and risk metrics (annualized volatility, beta, VaR)',
        'quantitative analysis: expected return and risk-adjusted return (Sharpe)',
        'industry status quo and competitive position',
        'moat and competitive advantages',
        'catalysts',
        'risks',
        'recommendation: buy/hold/sell with conviction level',
    ],
    timeConstraints: ['current date: 2026-08-10', 'use the most recent financial data available'],
    entityTypes: ['company name', 'stock ticker', 'industry peers', 'financial metrics'],
    queryHints: [
        '<company> latest quarterly results revenue EPS guidance',
        '<company> balance sheet debt free cash flow 10-K',
        '<company> industry competitive landscape market share',
        '<company> analyst price target consensus',
        '<industry> sector outlook 2026',
        '<company> historical returns volatility beta',
        '<company> valuation DCF multiples vs peers',
    ],
    directAnswerTemplate: 'A clear buy/hold/sell recommendation for TICKER with a price target, backed by quantitative analysis (Ito/GBM-based expected return and risk) and company/industry research.',
};
const HIGH_CREDIBILITY_TLDS = new Set(['.edu', '.gov', '.org', '.ac.uk', '.ac.au', '.ac.nz']);
const LOW_CREDIBILITY_SIGNALS = [
    /\bad\b/i, /advertis/i, /sponsored/i, /affiliate/i, /click.?here/i,
    /buy.?now/i, /free.?download/i, /casino/i, /forex/i, /crypto.?pump/i,
];
const DEFAULT_NEGATIVE_URL_PATTERNS = [
    /\/students\//i, /\/login\b/i, /\/signup\b/i, /\/register\b/i,
    /\/docs\//i, /\/cart\b/i, /\/checkout\b/i, /\/account\b/i,
    /\/profile\b/i, /\/forum\b/i, /\/tag\//i, /\/category\//i,
    /\/search\?/i, /\/index\.php\?/i,
];
const DEFAULT_ACADEMIC_WHITELIST = new Set(['reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'ft.com', 'economist.com', 'nature.com', 'science.org', 'sciencedirect.com', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'arxiv.org', 'jstor.org', 'plos.org', 'pnas.org', 'thelancet.com', 'nejm.org', 'jamanetwork.com', 'bmj.com', 'cell.com', 'springer.com', 'wiley.com', 'tandfonline.com', 'statista.com', 'oecd.org', 'worldbank.org', 'imf.org', 'data.un.org', 'ourworldindata.org', 'who.int', 'un.org', 'europa.eu', 'sec.gov', 'federalreserve.gov']);
const DEFAULT_ACADEMIC_BLACKLIST = new Set(['wikipedia.org', 'wikimedia.org', 'wikia.com', 'fandom.com', 'quora.com', 'reddit.com', 'stackexchange.com', 'stackoverflow.com', 'answers.com', 'ask.com', 'ehow.com', 'livestrong.com', 'about.com', 'thoughtco.com']);
async function isolatedCall(callChat, systemPrompt, userContent, opts = {}) {
    return callChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }], false, null, { ...opts, think: false, autoSystemPrompt: false });
}
async function detectAnswerFormat(callChat, topic, opts = {}) {
    const r = await callChat([{ role: 'system', content: `You are a Strategic Answer-Format Analyst. Your goal is to decompose a research request into a formal target specification.

ANALYSIS PROCESS:
1. Identify the core question and the explicit goal.
2. Determine the optimal output structure (e.g., a comparative table for 'comparison', a detailed technical breakdown for 'analysis').
3. Identify "Must-Have" data points (Required Fields) that would make an answer objectively complete.
4. Extract specific temporal constraints (e.g., "last 5 years", "post-2020").
5. Predict the specific entities (companies, laws, isotopes, events) that will be the primary nodes of evidence.
6. Brainstorm "High-Information" search queries—queries that target the specific intersections of the topic.

Output ONLY valid JSON — no markdown fences, no prose:
{
  "answerType": "list|comparison|explanation|recommendation|analysis|data",
  "requiredFields": ["concrete data points a correct answer must contain"],
  "timeConstraints": ["any date or recency requirements, verbatim from the query"],
  "entityTypes": ["types of entities to find, e.g. company names, stock symbols, prices"],
  "queryHints": ["5 highly specific search queries that would find the answer"],
  "directAnswerTemplate": "A precise, one-sentence template of the ideal final answer."
}

CRITICAL: Respond with RAW JSON ONLY. Start with '{' and end with '}'.` },
        { role: 'user', content: `Research request: ${topic}` }], false, null, { ...opts, think: false, samplingProfile: 'json' });
    const parsed = parseJsonSafe(r.content || '', AnswerFormatSpecSchema);
    if (parsed) {
        log({ level: 'info', msg: `[STEP 0] Answer format: type=${parsed.answerType} | fields=${(parsed.requiredFields || []).join(', ')}`, source: 'researchAgent', ts: Date.now() });
        return parsed;
    }
    log({ level: 'warn', msg: '[STEP 0] Format detection parse failed — using passthrough spec', source: 'researchAgent', ts: Date.now() });
    return { answerType: 'analysis', requiredFields: ['relevant information', 'specific facts'], timeConstraints: [], entityTypes: [], queryHints: [topic], directAnswerTemplate: 'A direct answer to the question.' };
}
async function plannerAgent(callChat, topic, answerSpec, opts = {}) {
    const maxQueries = opts.maxQueries ?? 12;
    // split the TOTAL budget across depths in a 4:2:1 ratio — maxQueries is a
    // hard cap, not a per-depth budget (previously this emitted 1.75x queries)
    const d0count = Math.ceil(maxQueries * 4 / 7);
    const d1count = Math.ceil(maxQueries * 2 / 7);
    const d2count = Math.max(0, maxQueries - d0count - d1count);
    const queryHintsBlock = (answerSpec.queryHints || []).length ? `\nPrioritize queries in this space:\n${answerSpec.queryHints.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}` : '';
    const entityNote = (answerSpec.entityTypes || []).length ? `\nEvery query should aim to surface: ${answerSpec.entityTypes.join(', ')}.` : '';
    const timeNote = (answerSpec.timeConstraints || []).length ? `\nTime constraints to honour: ${answerSpec.timeConstraints.join('; ')}.` : '';
    log({ level: 'info', msg: `[STEP 1] Query DAG expansion for: "${topic.slice(0, 60)}..."`, source: 'researchAgent', ts: Date.now() });
    const r = await callChat([{ role: 'system', content: `You are a Research Strategy Architect. Design a diverse search query portfolio to maximize "Information Gain" and eliminate blind spots.

STRATEGY:
- Depth 0 (Broad Context): Establish the baseline, definitions, and overall landscape.
- Depth 1 (Specifics): Target the "Required Output Fields" and key entities.
- Depth 2 (Granular/Nuanced): Search for edge cases, contradictory evidence, and highly specific technical details.

CONSTRAINTS:
- THE EXACT QUESTION: "${topic}"
- REQUIRED FORMAT: ${answerSpec.answerType}
- REQUIRED DATA: ${(answerSpec.requiredFields || []).join(', ')}
${entityNote}${timeNote}${queryHintsBlock}

QUERY DESIGN RULES:
1. Divergent Thinking: Do not simply paraphrase. Use different terminologies (e.g., academic vs. industry terms).
2. Explicit Goals: Every query must have a clear "Information Objective" (e.g., "Find the specific 2023 revenue for X").
3. Temporal Alignment: Embed dates/years directly into queries to match time constraints.
4. Entity Targeting: Use queries that name-drop the predicted entity types.

Query budget: depth-0: ${d0count}, depth-1: ${d1count}, depth-2: ${d2count}

Output ONLY valid JSON — no markdown fences, no prose:
{"queries": [{"query": "search string", "goal": "exact information objective", "depth": 0|1|2, "topic": "sub-topic label"}]}

CRITICAL: Respond with RAW JSON ONLY. Start with '{' and end with '}'.` },
        { role: 'user', content: `Research topic: ${topic}` }], false, null, { ...opts, think: true, samplingProfile: 'planning' });
    const parsed = parseJsonSafe(r.content || '', PlannerPlanSchema);
    if (parsed) {
        const total = d0count + d1count + d2count;
        const sliced = parsed.queries.slice(0, total);
        log({ level: 'info', msg: `[STEP 1] Generated ${sliced.length} queries across 3 DAG depths`, source: 'researchAgent', ts: Date.now() });
        return sliced;
    }
    log({ level: 'warn', msg: '[STEP 1] JSON parse failed — using fallback queries', source: 'researchAgent', ts: Date.now() });
    return (answerSpec.queryHints || [topic]).map((q, i) => ({ query: q, goal: 'Directly answer the user question', depth: i === 0 ? 0 : 1, topic: 'general' }));
}
async function crawlerAgent(queries, maxConcurrency = 5, opts = {}) {
    const searchLabel = opts.useOllamaSearch ? 'Ollama API' : 'SearXNG';
    log({ level: 'info', msg: `[STEP 2] Parallel crawl via ${searchLabel} — ${queries.length} queries, concurrency=${maxConcurrency}`, source: 'researchAgent', ts: Date.now() });
    const results = [];
    const seenUrls = new Set();
    for (let i = 0; i < queries.length; i += maxConcurrency) {
        const batch = queries.slice(i, i + maxConcurrency);
        const batchResults = await Promise.allSettled(batch.map(async ({ query, goal, depth, topic }) => {
            const searchResults = await getSearchResults(query, opts);
            if (!Array.isArray(searchResults))
                return [];
            return searchResults.map((r) => ({ url: r.link, title: r.title || '', snippet: r.snippet || '', cite: r.cite || '', query, goal, depth, topic: topic || 'general' }));
        }));
        for (const settled of batchResults) {
            if (settled.status === 'fulfilled' && Array.isArray(settled.value)) {
                for (const item of settled.value) {
                    if (item.url && !seenUrls.has(item.url)) {
                        seenUrls.add(item.url);
                        results.push(item);
                    }
                }
            }
        }
        log({ level: 'info', msg: `[STEP 2] Batch ${Math.ceil((i + 1) / maxConcurrency)} complete — ${results.length} unique URLs so far`, source: 'researchAgent', ts: Date.now() });
    }
    return results;
}
function scoreCredibility(result, opts = {}) {
    let score = 40;
    const { url = '', snippet = '', title = '' } = result;
    try {
        const hostname = new URL(url).hostname;
        const tld2 = '.' + hostname.split('.').slice(-2).join('.');
        const tld1 = '.' + hostname.split('.').pop();
        if (HIGH_CREDIBILITY_TLDS.has(tld2))
            score += 30;
        else if (HIGH_CREDIBILITY_TLDS.has(tld1))
            score += 20;
    }
    catch {
        score -= 20;
    }
    const text = (snippet + ' ' + title).toLowerCase();
    const academicSignals = ['study', 'research', 'analysis', 'data', 'findings', 'published', 'journal', 'peer-reviewed', 'according to', 'evidence'];
    score += Math.min(academicSignals.filter(s => text.includes(s)).length * 3, 20);
    if (snippet.length > 200)
        score += 10;
    if (snippet.length < 30)
        score -= 15;
    for (const pattern of LOW_CREDIBILITY_SIGNALS) {
        if (pattern.test(url) || pattern.test(text)) {
            score -= 25;
            break;
        }
    }
    if (result.depth === 0)
        score += 5;
    const negPatterns = opts.credNegativePatterns || DEFAULT_NEGATIVE_URL_PATTERNS;
    for (const pattern of negPatterns) {
        if (pattern.test(url)) {
            score -= 50;
            break;
        }
    }
    try {
        const parsed = new URL(url);
        const p = parsed.pathname.replace(/\/$/, '');
        if (p === '' || p === '/index.html' || p === '/index.php')
            score -= 20;
    }
    catch { /* ignore */ }
    return Math.max(0, Math.min(100, score));
}
function verificationAgent(rawResults, threshold = 35, opts = {}) {
    let results = rawResults;
    if (opts.academicFilter) {
        const wlMode = opts.academicWhitelistMode || 'extend';
        const whitelist = wlMode === 'replace' && opts.academicWhitelist ? new Set(opts.academicWhitelist) : new Set([...DEFAULT_ACADEMIC_WHITELIST, ...(opts.academicWhitelist || [])]);
        const blMode = opts.academicBlacklistMode || 'extend';
        const blacklist = blMode === 'replace' && opts.academicBlacklist ? new Set(opts.academicBlacklist) : new Set([...DEFAULT_ACADEMIC_BLACKLIST, ...(opts.academicBlacklist || [])]);
        const academic = new Set(['.edu', '.gov', '.org', '.ac.uk', '.ac.au', '.ac.nz']);
        const before = results.length;
        results = results.filter((r) => {
            let hostname = '';
            try {
                hostname = new URL(r.url || '').hostname;
            }
            catch {
                return false;
            }
            if (blacklist.has(hostname))
                return false;
            if (whitelist.has(hostname))
                return true;
            const parts = hostname.split('.');
            const tld2 = '.' + parts.slice(-2).join('.');
            const tld1 = '.' + parts[parts.length - 1];
            return academic.has(tld2) || academic.has(tld1);
        });
        log({ level: 'info', msg: `[STEP 3] Academic filter: ${before} → ${results.length} URLs`, source: 'researchAgent', ts: Date.now() });
    }
    const scored = results.map((r) => ({ ...r, credibilityScore: scoreCredibility(r, opts) })).filter((r) => r.credibilityScore >= threshold).sort((a, b) => b.credibilityScore - a.credibilityScore);
    log({ level: 'info', msg: `[STEP 3] Credibility filter: ${results.length} → ${scored.length} URLs (threshold=${threshold})`, source: 'researchAgent', ts: Date.now() });
    return scored;
}
async function extractAndSummarize(callChat, source, topic, answerSpec, opts) {
    const { url, goal, query, credibilityScore } = source;
    let rawContent;
    if (source.localContent) {
        // local file source — content was converted at injection time
        rawContent = source.localContent;
    }
    else {
        try {
            rawContent = await getFetchResults(url);
            if (!rawContent || typeof rawContent !== 'string' || rawContent.startsWith('Error:')) {
                return { url, goal, summary: null, credibilityScore, error: rawContent || 'Fetch failed' };
            }
        }
        catch (e) {
            return { url, goal, summary: null, credibilityScore, error: e.message };
        }
    }
    // context guard: a long article or a big local PDF would overflow the
    // extraction call. keep the head (where key facts live) plus the tail
    // (where conclusions live), and say so in the prompt.
    const MAX_CONTENT = opts.maxSourceChars ?? 50000;
    if (rawContent.length > MAX_CONTENT) {
        const head = rawContent.slice(0, Math.floor(MAX_CONTENT * 0.8));
        const tail = rawContent.slice(-Math.floor(MAX_CONTENT * 0.2));
        rawContent = `${head}\n\n[... ${rawContent.length - MAX_CONTENT} chars of the middle omitted to fit context ...]\n\n${tail}`;
    }
    const requiredFieldsNote = (answerSpec.requiredFields || []).length ? `\nSpecifically extract: ${answerSpec.requiredFields.join(', ')}.` : '';
    const timeNote = (answerSpec.timeConstraints || []).length ? `\nOnly include content matching these time constraints: ${answerSpec.timeConstraints.join('; ')}.` : '';
    const entityNote = (answerSpec.entityTypes || []).length ? `\nPrioritize finding: ${answerSpec.entityTypes.join(', ')}.` : '';
    let rawSummary = '';
    if (opts.cognitiveFlow) {
        if (typeof opts.onChunk === 'function') {
            opts.onChunk(`\n\n--- [RESEARCH AGENT] Applying Cognitive Flow to Source: ${url} ---\n\n`, { kind: 'content' });
        }
        const analysisPrompt = `Research Goal: ${goal}\nSearch Query: ${query}\nSource URL: ${url}\n\nContent:\n${rawContent}\n\nAnalyze this content comprehensively to answer: "${topic}"`;
        const flowResult = await runCognitiveFlow(callChat, analysisPrompt, opts);
        const formatR = await callChat([{ role: 'system', content: `You are a High-Density Semantic Extraction Engine. Your task is to synthesize evidence for a specific research goal.\n\nGOAL: Answer "${topic}"\n${requiredFieldsNote}${timeNote}${entityNote}\n\nMANDATORY DATE PROTOCOL:\n1. Locate the definitive PUBLICATION DATE of the source.\n2. Output it on the VERY FIRST LINE: "PUBLICATION_DATE: YYYY-MM-DD" (or "unknown").\n3. Every quantitative claim or specific event must be tagged with its source year in parentheses, e.g., "Revenue grew by 12% (2022)".\n\nEXTRACTION GUIDELINES:\n- Precision First: Extract exact figures, proper names, symbols, and technical specifications.\n- Zero Loss: Do not paraphrase away technical precision. If the text says "approximately 4.231", do not write "about 4".\n- Relevance Filter: Extract ONLY content that directly supports the research goal.\n- Signal-to-Noise: If the page contains no relevant evidence, output exactly: NO_RELEVANT_CONTENT.\n\nOUTPUT FORMAT:\nLine 1: PUBLICATION_DATE: ...\nRemaining: 2-5 dense, factual paragraphs. Focus on evidence, not narrative.` },
            { role: 'user', content: `Cognitive Analysis Result:\n${flowResult}\n\nNow, output the formal extraction block starting with PUBLICATION_DATE:` }], false, null, { ...opts, think: false, samplingProfile: 'reasoning' });
        rawSummary = (formatR.content || '').trim();
    }
    else {
        const r = await callChat([{ role: 'system', content: `You are a High-Density Semantic Extraction Engine. Your task is to synthesize evidence for a specific research goal.\n\nGOAL: Answer "${topic}"\n${requiredFieldsNote}${timeNote}${entityNote}\n\nMANDATORY DATE PROTOCOL:\n1. Locate the definitive PUBLICATION DATE of the source.\n2. Output it on the VERY FIRST LINE: "PUBLICATION_DATE: YYYY-MM-DD" (or "unknown").\n3. Every quantitative claim or specific event must be tagged with its source year in parentheses, e.g., "Revenue grew by 12% (2022)".\n\nEXTRACTION GUIDELINES:\n- Precision First: Extract exact figures, proper names, symbols, and technical specifications.\n- Zero Loss: Do not paraphrase away technical precision. If the text says "approximately 4.231", do not write "about 4".\n- Relevance Filter: Extract ONLY content that directly supports the research goal.\n- Signal-to-Noise: If the page contains no relevant evidence, output exactly: NO_RELEVANT_CONTENT.\n\nOUTPUT FORMAT:\nLine 1: PUBLICATION_DATE: ...\nRemaining: 2-5 dense, factual paragraphs. Focus on evidence, not narrative.` },
            { role: 'user', content: `Research Goal: ${goal}\nSearch Query: ${query}\nSource URL: ${url}\n\nContent:\n${rawContent}\n\nExtract content relevant to: "${topic}"` }], false, null, { ...opts, think: false, samplingProfile: 'reasoning' });
        rawSummary = (r.content || '').trim();
    }
    if (!rawSummary || rawSummary === 'NO_RELEVANT_CONTENT' || rawSummary.length < 50) {
        return { url, goal, summary: null, credibilityScore, error: 'No relevant content found' };
    }
    let publicationDate = 'unknown';
    let summary = rawSummary;
    const dateLine = rawSummary.split('\n')[0] || '';
    const dateMatch = dateLine.match(/^PUBLICATION_DATE:\s*(.+)$/i);
    if (dateMatch) {
        publicationDate = dateMatch[1].trim();
        summary = rawSummary.slice(dateLine.length).replace(/^\n+/, '').trim();
    }
    if (!summary || summary.length < 30)
        return { url, goal, summary: null, credibilityScore, error: 'No summary content after date extraction' };
    return { url, goal, query, summary, credibilityScore, publicationDate };
}
async function extractWithFallback(callChat, primarySources, fallbackPool, topic, answerSpec, opts) {
    const maxToFetch = opts.maxSummaries ?? 20;
    const batchSize = opts.extractBatchSize ?? 10;
    const primaryUrls = new Set(primarySources.map(s => s.url));
    const fallbackQueue = fallbackPool.filter(s => !primaryUrls.has(s.url));
    let fallbackIdx = 0;
    const results = [];
    const workQueue = [...primarySources.slice(0, maxToFetch)];
    log({ level: 'info', msg: `[STEP 4] Fetching ${workQueue.length} sources (${fallbackQueue.length} in fallback pool)...`, source: 'researchAgent', ts: Date.now() });
    for (let i = 0; i < workQueue.length; i += batchSize) {
        const batch = workQueue.slice(i, i + batchSize);
        const settled = await Promise.allSettled(batch.map(s => extractAndSummarize(callChat, s, topic, answerSpec, opts)));
        for (const outcome of settled) {
            if (outcome.status === 'fulfilled' && outcome.value?.summary && !outcome.value.error) {
                results.push(outcome.value);
            }
            else {
                while (fallbackIdx < fallbackQueue.length) {
                    const fb = fallbackQueue[fallbackIdx++];
                    try {
                        const fbResult = await extractAndSummarize(callChat, fb, topic, answerSpec, opts);
                        if (fbResult?.summary && !fbResult.error) {
                            log({ level: 'warn', msg: `[STEP 4] Fallback used: ${fb.url.slice(0, 60)}`, source: 'researchAgent', ts: Date.now() });
                            results.push(fbResult);
                            break;
                        }
                    }
                    catch { /* ignore */ }
                }
            }
        }
    }
    log({ level: 'info', msg: `[STEP 4] Raw extraction: ${results.length} valid summaries`, source: 'researchAgent', ts: Date.now() });
    if (results.length === 0)
        return [];
    if (results.length <= 5)
        return results;
    const summaryIndex = results.map((s, i) => `[${i}] URL: ${s.url}\nCredibility: ${s.credibilityScore}\nExcerpt: ${s.summary || ''}`).join('\n\n---\n\n');
    try {
        const rankR = await isolatedCall(callChat, `You are a Research Relevance Ranker.\nGiven a topic and source summaries, rank them by how directly they answer the topic.\nOutput ONLY valid JSON — no prose, no markdown fences: {"ranked": [0, 3, 1, ...]}\nInclude ALL indices in the output. Do not filter any out.`, `Topic: "${topic}"\n\nSummaries:\n${summaryIndex}`, { ...opts, samplingProfile: 'json' });
        const rankData = parseJsonSafe(rankR.content || '', RankedSchema);
        if (rankData && rankData.ranked.length === results.length) {
            const reranked = rankData.ranked.filter(idx => typeof idx === 'number' && idx >= 0 && idx < results.length).map(idx => results[idx]);
            log({ level: 'info', msg: `[STEP 4] Meta-selection reranked ${reranked.length} summaries`, source: 'researchAgent', ts: Date.now() });
            return reranked;
        }
    }
    catch (e) {
        log({ level: 'warn', msg: `[STEP 4] Meta-selection failed (${e.message}) — using credibility order`, source: 'researchAgent', ts: Date.now() });
    }
    return results;
}
function applyMMR(summaries, maxResults = 20, diversityLambda = 0.6) {
    if (summaries.length <= maxResults)
        return summaries;
    function tokenize(text) { return new Set((text || '').toLowerCase().match(/\b\w{4,}\b/g) || []); }
    function jaccardSim(a, b) {
        const sa = tokenize(a), sb = tokenize(b);
        const inter = [...sa].filter(x => sb.has(x)).length;
        const union = new Set([...sa, ...sb]).size;
        return union === 0 ? 0 : inter / union;
    }
    const selected = [], candidates = [...summaries];
    while (selected.length < maxResults && candidates.length > 0) {
        let bestIdx = 0, bestScore = -Infinity;
        for (let i = 0; i < candidates.length; i++) {
            const relevance = candidates[i].credibilityScore / 100;
            const maxSim = selected.length > 0 ? Math.max(...selected.map(s => jaccardSim(s.summary || '', candidates[i].summary || ''))) : 0;
            const mmrScore = diversityLambda * relevance - (1 - diversityLambda) * maxSim;
            if (mmrScore > bestScore) {
                bestScore = mmrScore;
                bestIdx = i;
            }
        }
        selected.push(candidates.splice(bestIdx, 1)[0]);
    }
    log({ level: 'info', msg: `[STEP 4] MMR diversity filter: ${summaries.length} → ${selected.length} summaries`, source: 'researchAgent', ts: Date.now() });
    return selected;
}
async function verifyOneSource(callChat, source, topic, opts) {
    const pubDateNote = source.publicationDate && source.publicationDate !== 'unknown' ? `\nThis article was published on: ${source.publicationDate}. Any claim must include this date context.` : '\nPublication date is unknown for this source.';
    const claimsR = await callChat([{ role: 'system', content: `Extract every distinct factual claim from this summary relevant to: "${topic}"\nOutput ONLY valid JSON — no markdown fences, no prose: {"claims": ["claim 1", "claim 2", ...]}\nA claim is a specific, verifiable assertion with concrete data (numbers, names, dates, symbols).\nIMPORTANT: Each claim must include the year/date of the data.\nDo NOT omit or change the year to a different year.${pubDateNote}` },
        { role: 'user', content: `Summary from ${source.url}:\n${source.summary || ''}` }], false, null, { ...opts, think: false, samplingProfile: 'json' });
    const claimsParsed = parseJsonSafe(claimsR.content || '', ClaimsSchema);
    const claims = claimsParsed?.claims || [];
    if (claims.length === 0)
        return [];
    let citationData = null;
    // local files can't be fetched for citation metadata — skip the doomed
    // network call (it would just burn the 15s timeout) and let the report
    // writer fall back to the file basename.
    if (!String(source.url || '').startsWith('file://')) {
        try {
            const citResult = await generateCitation(source.url);
            if (!citResult.error)
                citationData = citResult;
        }
        catch { /* ignore */ }
    }
    const max = 2;
    const verifiedClaims = [];
    for (const claim of claims) {
        let verifiedClaim = claim, verified = false;
        for (let loop = 0; loop < max; loop++) {
            const verifyR = await callChat([{ role: 'system', content: `You are a Fact Verifier.\nSource content:\n${source.summary || ''}\n\nDATE RULES — CRITICAL:\n  - The article was published on: ${source.publicationDate || 'unknown'}.\n  - Do NOT change any year or date in the claim.\n  - If the article is from 2023 or 2024, label it historical — NOT 2026.\n\nDoes the source content explicitly support the claim?\nOutput ONLY valid JSON — no markdown fences:\n{"supported": true|false, "confidence": 0-100, "correction": "corrected claim or null"}` },
                { role: 'user', content: `Claim: "${verifiedClaim}"\nSource: ${source.url}` }], false, null, { ...opts, think: false, samplingProfile: 'verify' });
            const vResult = parseJsonSafe(verifyR.content || '', VerifyResultSchema);
            if (vResult?.supported && vResult.confidence >= 60) {
                verified = true;
                break;
            }
            else if (vResult?.correction && loop < max - 1) {
                log({ level: 'warn', msg: `[STEP 5] Claim corrected: "${verifiedClaim.slice(0, 100)}..."`, source: 'researchAgent', ts: Date.now() });
                verifiedClaim = vResult.correction;
            }
            else {
                log({ level: 'warn', msg: `[STEP 5] Claim discarded: "${verifiedClaim.slice(0, 100)}..."`, source: 'researchAgent', ts: Date.now() });
                break;
            }
        }
        if (verified)
            verifiedClaims.push({ claim: verifiedClaim, url: source.url, title: source.title || '', goal: source.goal, credibility: source.credibilityScore, publicationDate: source.publicationDate || 'unknown', citation: citationData, citedSummary: source.summary, verified: true });
    }
    log({ level: 'info', msg: `[STEP 5] ${source.url.slice(0, 50)}... → ${verifiedClaims.length}/${claims.length} claims verified`, source: 'researchAgent', ts: Date.now() });
    return verifiedClaims;
}
async function factVerificationLoop(callChat, validSummaries, topic, opts) {
    log({ level: 'info', msg: `[STEP 5] FACT verification loop — ${validSummaries.length} summaries`, source: 'researchAgent', ts: Date.now() });
    const verifiedNodes = [];
    // sources are independent — verify them in parallel batches so a 20-source
    // run doesn't serialize ~60 LLM calls. results keep source order.
    const concurrency = opts.verifyConcurrency ?? 4;
    for (let i = 0; i < validSummaries.length; i += concurrency) {
        const batch = validSummaries.slice(i, i + concurrency);
        const settled = await Promise.allSettled(batch.map(s => verifyOneSource(callChat, s, topic, opts)));
        for (const outcome of settled) {
            if (outcome.status === 'fulfilled' && Array.isArray(outcome.value))
                verifiedNodes.push(...outcome.value);
            else
                log({ level: 'warn', msg: `[STEP 5] Source verification failed: ${outcome.reason?.message || 'unknown'}`, source: 'researchAgent', ts: Date.now() });
        }
    }
    log({ level: 'success', msg: `[STEP 5] FACT complete — ${verifiedNodes.length} total verified claims`, source: 'researchAgent', ts: Date.now() });
    return verifiedNodes;
}
function buildAPACitation(ref) {
    const author = ref.author && ref.author !== 'Unknown Author' && ref.author.trim() ? ref.author.trim() : '';
    const year = ref.year || 'n.d.';
    const title = (ref.title || 'Untitled').trim();
    const site = (ref.site || (() => { try {
        return new URL(ref.url).hostname;
    }
    catch {
        return ref.url;
    } })()).trim();
    const url = ref.url;
    const authorPart = author ? `${author} ` : '';
    return `${authorPart}(${year}). *${title}*. ${site}. ${url}`;
}
function buildCoverageGapsDisclaimer(plannedQueries, verifiedNodes) {
    if (!Array.isArray(plannedQueries) || plannedQueries.length === 0)
        return null;
    const plannedTopics = [...new Set(plannedQueries.map((q) => (q.topic || q.goal || q.query || '').slice(0, 60)).filter(Boolean))];
    if (plannedTopics.length === 0)
        return null;
    const coveredGoals = new Set(verifiedNodes.map(n => (n.goal || '').toLowerCase()));
    const missingTopics = plannedTopics.filter((pt) => {
        const ptLower = pt.toLowerCase();
        return ![...coveredGoals].some(goal => goal.split(/\s+/).some((word) => word.length > 4 && ptLower.includes(word)));
    });
    if (missingTopics.length === 0)
        return null;
    const ratio = Math.round(missingTopics.length / plannedTopics.length * 100);
    if (ratio < 20)
        return null;
    return `## Coverage Gaps\n\nThis report was planned to cover **${plannedTopics.length} topic areas**, but **${missingTopics.length} (${ratio}%)** returned no verified data, likely due to paywalls, bot-protection, or search engine rate-limiting.\n\n**Topics with no recovered data:**\n${missingTopics.slice(0, 15).map((t) => `- ${t}`).join('\n')}${missingTopics.length > 15 ? `\n- *(and ${missingTopics.length - 15} more...)*` : ''}\n\nFindings in this report are limited to sectors where data was successfully retrieved.\n\n---\n`;
}
// merge near-duplicate claims from different sources before the writer sees
// them. two claims are duplicates when they share a distinctive number
// (dollar amount, percentage, year) AND overlap in subject words — e.g. the
// same price target reported by two sites. merged claims carry both source
// URLs so the writer cites both in ONE paragraph instead of repeating the
// fact in separate sections. qualitative claims (no numbers) never merge.
function mergeDuplicateClaims(nodes) {
    // number normalization so the same fact cited twice collides even when
    // the phrasing differs: "$253.49B" == "253.49 billion" == "253.49b USD",
    // and "6.53" ~ "6.54" (sources round differently). each token yields its
    // exact key PLUS a 1-decimal-rounded key, so near-equal figures match.
    // bare 4-digit years and bare single digits are NOT distinctive ("2026"
    // appears in every claim; "5" in "5-year") and are dropped.
    const numsOf = (s) => {
        const out = new Set();
        const toks = (s.toLowerCase().match(/\$?[\d,]+(?:\.\d+)?\s*(?:billion|million|trillion|[bm%])?/gi) || []);
        for (const t of toks) {
            const k = t.replace(/[\$,]/g, '').replace(/\s*(billion|million|trillion)\s*/g, (_m, w) => w[0]).replace(/\s+/g, '');
            const m = k.match(/^(\d+)(?:\.(\d+))?([bm%])?$/);
            if (!m)
                continue;
            const suffix = m[3] || '';
            // drop bare years ("2026") and bare single digits ("5" in "5-year") —
            // they are not distinctive. decimals like "6.53" keep their value.
            if (!suffix && !m[2] && (m[1].length === 4 || m[1].length === 1))
                continue;
            out.add(k);
            const rounded = Math.round(parseFloat(m[1] + (m[2] ? '.' + m[2] : '')) * 10) / 10;
            if (!isNaN(rounded))
                out.add(String(rounded) + suffix);
        }
        return out;
    };
    const wordsOf = (s) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 12));
    const out = [];
    const used = new Set();
    for (let i = 0; i < nodes.length; i++) {
        if (used.has(i))
            continue;
        const a = nodes[i];
        const numsA = numsOf(a.claim || '');
        const wordsA = wordsOf(a.claim || '');
        const merged = { ...a, urls: [a.url] };
        for (let j = i + 1; j < nodes.length; j++) {
            if (used.has(j))
                continue;
            const b = nodes[j];
            const numsB = numsOf(b.claim || '');
            const sharedNums = [...numsA].filter((n) => numsB.has(n)).length;
            if (sharedNums < 1)
                continue;
            const wordsB = wordsOf(b.claim || '');
            const sharedWords = [...wordsA].filter((w) => wordsB.has(w)).length;
            // same distinctive number twice (exact + rounded variants) is nearly
            // proof of the same fact; one number + a shared content word also
            // holds for "diluted EPS 6.53" vs "diluted EPS 6.54".
            if (sharedNums >= 2 || (sharedNums >= 1 && sharedWords >= 1)) {
                used.add(j);
                merged.urls.push(b.url);
                log({ level: 'info', msg: `[STEP 6] Merged duplicate claim (${sharedNums} shared nums, ${sharedWords} shared words): "${(a.claim || '').slice(0, 60)}..." + "${(b.claim || '').slice(0, 60)}..."`, source: 'researchAgent', ts: Date.now() });
            }
        }
        out.push(merged);
    }
    return out;
}
async function reportWriterAgent(callChat, topic, answerSpec, verifiedNodes, opts, plannedQueries = [], quantModel = null) {
    log({ level: 'info', msg: `[STEP 6] Report Writer — ${verifiedNodes.length} verified claims, ${plannedQueries.length} planned queries`, source: 'researchAgent', ts: Date.now() });
    const chunk = opts.chunkSize ?? 20;
    const tail = opts.tailChars ?? 1500;
    const coverageGaps = buildCoverageGapsDisclaimer(plannedQueries, verifiedNodes);
    if (coverageGaps)
        log({ level: 'warn', msg: '[STEP 6] Coverage gaps detected — disclaimer will be prepended', source: 'researchAgent', ts: Date.now() });
    const deduped = mergeDuplicateClaims(verifiedNodes);
    if (deduped.length < verifiedNodes.length)
        log({ level: 'info', msg: `[STEP 6] Claim dedup: ${verifiedNodes.length} -> ${deduped.length}`, source: 'researchAgent', ts: Date.now() });
    const refMap = new Map();
    for (const node of deduped) {
        for (const u of node.urls || [node.url]) {
            if (!refMap.has(u)) {
                const cData = node.citation?.data || {};
                const siteFallback = (() => { try {
                    const h = new URL(u).hostname;
                    return h || (u.startsWith('file://') ? node.title : u);
                }
                catch {
                    return u;
                } })();
                refMap.set(u, { id: refMap.size + 1, url: u, title: cData.title || node.title || node.citedSummary || 'Untitled', author: cData.author || '', year: cData.year || node.publicationDate || 'n.d.', site: cData.site || siteFallback });
            }
        }
    }
    for (const [, ref] of refMap)
        ref.apa = buildAPACitation(ref);
    const chunks = [];
    for (let i = 0; i < deduped.length; i += chunk)
        chunks.push(deduped.slice(i, i + chunk));
    log({ level: 'info', msg: `[STEP 6] Writing ${chunks.length} sections...`, source: 'researchAgent', ts: Date.now() });
    const sections = [];
    let previousTail = '';
    const requiredNote = (answerSpec.requiredFields || []).length ? `Required output fields: ${answerSpec.requiredFields.join(', ')}.` : '';
    const timeNote = (answerSpec.timeConstraints || []).length ? `Honour time constraints: ${answerSpec.timeConstraints.join('; ')}.` : '';
    // stock mode: the report must actually DO the math, not just claim it.
    // a DCF without a stated intrinsic value, or an Ito mention without an
    // applied derivation, reads as hand-waving — the quant verifier flags it.
    // when the quant engine ran, the pipeline already computed the real math
    // from the verified claims — the writer must adopt those exact numbers,
    // not invent its own, so the report's numbers are code-computed truth.
    let quantNote = '';
    if (quantModel && quantModel.ok) {
        quantNote = `\n\nTHE PIPELINE COMPUTED THESE VALUES FROM YOUR VERIFIED CLAIMS (deterministic code, not LLM estimates). USE THESE EXACT NUMBERS in your prose — do NOT invent different ones:\n` +
            `  - Cost of equity (CAPM): ${(quantModel.costOfEquity * 100).toFixed(2)}%\n` +
            `  - Intrinsic value from 10-year DCF: $${quantModel.intrinsicValue.toFixed(2)}/share (${(quantModel.upside >= 0 ? '+' : '') + (quantModel.upside * 100).toFixed(1)}% vs current price)\n` +
            `  - Expected annual return (GBM drift μ): ${(quantModel.expectedReturn * 100).toFixed(1)}%\n` +
            `  - Expected log-return, Ito drift correction (μ - σ²/2): ${(quantModel.expectedLogReturn * 100).toFixed(1)}% (volatility drag σ²/2 = ${((quantModel.sigma * quantModel.sigma / 2) * 100).toFixed(1)}%)\n` +
            `  - Annualized volatility σ: ${(quantModel.sigma * 100).toFixed(1)}%\n` +
            `  - Sharpe ratio: ${quantModel.sharpe.toFixed(2)}\n` +
            `  - 1-day 95% VaR: $${quantModel.var95_1d.toFixed(2)} (${((quantModel.var95_1d / quantModel.price) * 100).toFixed(2)}%)\n` +
            `  - Expected price in one year E[S_T] = S₀e^{μT}: $${quantModel.expectedPrice.toFixed(2)}\n` +
            `  - A "## Quantitative Model" section with full derivations is appended automatically — write prose consistent with it.`;
    }
    const stockNote = opts.mode === 'stock'
        ? `\n\nSTOCK REPORT REQUIREMENTS (non-negotiable):\n  - If you run a DCF or Monte Carlo, STATE the resulting intrinsic value estimate in dollars per share.\n  - Apply Ito's lemma concretely: derive the expected log-return (μ - σ²/2)T and use it in your expected-return math. Do not just name-drop the equation.\n  - Every risk metric (VaR, Sharpe) must be consistent with the stated volatility: 1-day 95% VaR = 1.645 * σ / sqrt(252).\n  - State the expected return over your target horizon and the volatility that justifies the recommendation.${quantNote}`
        : '';
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunkSlice = chunks[ci];
        const isFirst = ci === 0;
        const taggedClaims = chunkSlice.map((node) => {
            const refIds = (node.urls || [node.url]).map((u) => refMap.get(u)?.id ?? '?');
            const pubTag = node.publicationDate && node.publicationDate !== 'unknown' ? ` [published ${node.publicationDate}]` : '';
            return `[Source ${refIds.join(', Source ')}${pubTag}] ${node.claim}`;
        }).join('\n');
        const continuityNote = isFirst ? `Begin with a 3-sentence Executive Summary answering: "${topic}"` : `Continue the report seamlessly. The previous section ended with:\n"...${previousTail}"`;
        const r = await callChat([{ role: 'system', content: `You are writing section ${ci + 1} of ${chunks.length} of a research report.\n\nORIGINAL QUESTION: "${topic}"\n${requiredNote}\n${timeNote}${stockNote}\n\nSECTION RULES:\n  1. Write complete, detailed prose for EVERY claim — do not skip any.\n  2. Do NOT save tokens. Do NOT summarize. Write fully.\n  3. Keep every [Source N] inline citation tag exactly as given.\n  4. Use ## subheadings to group claims by theme.\n  5. Do NOT write a conclusion — that comes in the final section.\n  6. Do NOT write a references section.\n  7. Do NOT repeat content from the previous section.\n  8. Each [Source N] tag includes a published date. When citing historical data,\n     clearly label it: "As of [date], ...". Do NOT present old data as current.\n\n${continuityNote}` },
            { role: 'user', content: `Claims for section ${ci + 1}:\n\n${taggedClaims}\n\nWrite the section now. Answer: "${topic}"` }], false, null, { ...opts, think: false, samplingProfile: 'creative' });
        const sectionText = (r.content || '').trim();
        sections.push(sectionText);
        previousTail = sectionText.slice(-tail);
        log({ level: 'info', msg: `[STEP 6] Section ${ci + 1}/${chunks.length} written (${sectionText.length} chars)`, source: 'researchAgent', ts: Date.now() });
    }
    const concatenated = sections.join('\n\n');
    log({ level: 'info', msg: '[STEP 6] Generating conclusion...', source: 'researchAgent', ts: Date.now() });
    const conclusionR = await callChat([{ role: 'system', content: `You are writing the CONCLUSION of a research report. One paragraph only.\n\nORIGINAL QUESTION: "${topic}"\nANSWER FORMAT: ${answerSpec.answerType}\nANSWER MUST CONTAIN: ${(answerSpec.requiredFields || []).join(', ')}\nTEMPLATE: ${answerSpec.directAnswerTemplate || 'A direct, specific answer.'}\n\nCONCLUSION RULES:\n  - Directly answer the question — name names, symbols, dates.\n  - Do NOT hedge with "it depends".\n  - One paragraph, 5–8 sentences maximum.\n  - Use [Source N] citations for key claims.\n  - If citing historical data, explicitly state the data's year.\n  - Do NOT write a references section.` },
        { role: 'user', content: `Research report (final portion):\n${concatenated.slice(-4000)}\n\nWrite ONE conclusion paragraph that directly answers: "${topic}"` }], false, null, { ...opts, think: true, samplingProfile: 'reasoning' });
    const conclusion = (conclusionR.content || '').trim();
    const refsSection = '\n\n---\n## References\n\n' + [...refMap.values()].sort((a, b) => a.id - b.id).map((ref) => `[${ref.id}] ${ref.apa}`).join('\n');
    const preamble = coverageGaps ? coverageGaps : '';
    let fullReport = preamble + concatenated + '\n\n---\n## Conclusion\n\n' + conclusion + refsSection;
    // citation integrity: every source must be cited in the body, every tag must
    // resolve, and the References section must list every source. the writer is
    // told to keep tags — this makes sure it actually did.
    const claimsByRef = new Map();
    for (const node of deduped) {
        for (const u of node.urls || [node.url]) {
            const id = refMap.get(u)?.id;
            if (id == null)
                continue;
            if (!claimsByRef.has(id))
                claimsByRef.set(id, []);
            claimsByRef.get(id).push(node.claim);
        }
    }
    const integrity = await enforceCitations(callChat, fullReport, refMap.size, claimsByRef, opts);
    fullReport = integrity.report;
    if (integrity.restored.length)
        log({ level: 'warn', msg: `[STEP 6] Citation integrity: restored ${integrity.restored.length} missing tags: [Source ${integrity.restored.join('], [Source ')}]`, source: 'researchAgent', ts: Date.now() });
    if (integrity.orphans.length)
        log({ level: 'warn', msg: `[STEP 6] Citation integrity: ${integrity.orphans.length} orphan tags removed: ${integrity.orphans.slice(0, 5).join(', ')}`, source: 'researchAgent', ts: Date.now() });
    const refCheck = checkReferencesSection(fullReport, refMap.size);
    if (!refCheck.ok)
        log({ level: 'warn', msg: `[STEP 6] References section missing entries: [${refCheck.missingRefs.join('], [')}]`, source: 'researchAgent', ts: Date.now() });
    log({ level: 'success', msg: `[STEP 6] Report done — ${fullReport.length} chars, ${refMap.size} sources, ${integrity.restored.length} citations restored`, source: 'researchAgent', ts: Date.now() });
    return { report: fullReport, references: [...refMap.values()], claimCount: verifiedNodes.length };
}
async function detectResearchDomain(callChat, topic, opts = {}) {
    log({ level: 'info', msg: '[STEP 7] Domain detection for expert persona generation...', source: 'researchAgent', ts: Date.now() });
    const r = await isolatedCall(callChat, `You are a Domain Classification System for academic research.\nGiven a research topic, identify the domain and generate an expert persona.\n\nOutput ONLY valid JSON — no markdown fences, no prose:\n{\n  "domain": "e.g. Mathematics",\n  "subdomain": "e.g. Analytic Number Theory",\n  "expertPersona": "Multi-sentence persona. Start: You are Professor [Name], a full professor of [subdomain] at [institution].",\n  "keyRigorStandards": ["Standard 1", "Standard 2", "Standard 3"],\n  "commonErrors": ["Error 1", "Error 2", "Error 3"]\n}`, `Research topic: ${topic}`, { ...opts, samplingProfile: 'json' });
    const parsed = parseJsonSafe(r.content || '', DomainSchema);
    if (parsed) {
        log({ level: 'info', msg: `[STEP 7] Domain: ${parsed.domain} / ${parsed.subdomain}`, source: 'researchAgent', ts: Date.now() });
        return parsed;
    }
    log({ level: 'warn', msg: '[STEP 7] Domain detection parse failed — using generic expert', source: 'researchAgent', ts: Date.now() });
    return { domain: 'General Research', subdomain: 'Academic Research', expertPersona: 'You are a senior research professor with 30 years of experience. You apply rigorous standards and do not accept unsupported claims. You check every assertion against cited evidence.', keyRigorStandards: ['Every claim must have a citation', 'Logical steps must be explicitly justified', 'Conclusions must follow from evidence presented'], commonErrors: ['Overgeneralization from limited data', 'Circular reasoning', 'Missing edge cases'] };
}
async function sourceFidelityVerifier(callChat, report, verifiedNodes, opts = {}) {
    log({ level: 'info', msg: '[STEP 8A] Source Fidelity Verifier starting...', source: 'researchAgent', ts: Date.now() });
    const evidenceIndex = verifiedNodes.slice(0, 30).map((node, i) => `SOURCE_EVIDENCE[${i + 1}]: "${node.citedSummary || node.claim || ''}"`).join('\n\n');
    const claimsList = verifiedNodes.slice(0, 30).map((node, i) => `CLAIM[${i + 1}]: ${node.claim} (citing source ${i + 1})`).join('\n');
    const r = await isolatedCall(callChat, `You are a Forensic Source Fidelity Auditor. Your mission is to detect "Evidence Drift"—where the report's claims subtly deviate from the source text.\n\nAUDIT PROTOCOL:\n  1. Map every claim to its specific source evidence.\n  2. Check for "Overreach": Did the report infer something the source only hinted at?\n  3. Check for "Precision Loss": Did the report round a number or simplify a technical term inaccurately?\n  4. Check for "Date Misattribution": Is a 2022 fact being presented as a 2026 fact?\n\nOutput ONLY valid JSON — no markdown fences, no prose:\n{"issues": [{"claimIndex": 1, "severity": "critical|major|minor", "type": "hallucinated|overreach|date_mismatch|number_mismatch|unsupported", "description": "...", "suggestion": "..."}], "totalChecked": 0, "fidelityScore": 0}\nIf zero issues are found, you must still justify why the fidelity is 100%.`, `CLAIMS TO CHECK:\n${claimsList}\n\nSOURCE EVIDENCE:\n${evidenceIndex}\n\nREPORT EXCERPT:\n${report}`, { ...opts, samplingProfile: 'verify' });
    const parsed = parseJsonSafe(r.content || '', SourceFidelitySchema);
    if (parsed) {
        log({ level: 'info', msg: `[STEP 8A] Source Fidelity: ${parsed.issues?.length ?? 0} issues found, score=${parsed.fidelityScore ?? 'N/A'}`, source: 'researchAgent', ts: Date.now() });
        return { agent: 'sourceFidelity', ...parsed };
    }
    log({ level: 'warn', msg: '[STEP 8A] Source fidelity parse failed', source: 'researchAgent', ts: Date.now() });
    return { agent: 'sourceFidelity', issues: [], totalChecked: 0, fidelityScore: 100 };
}
async function mathLogicVerifier(callChat, report, domain, opts = {}) {
    log({ level: 'info', msg: `[STEP 8B] Math/Logic Verifier starting (domain: ${domain.subdomain})...`, source: 'researchAgent', ts: Date.now() });
    const r = await isolatedCall(callChat, `You are a Formal Mathematical and Logical Consistency Auditor specializing in ${domain.subdomain}.\n\nYour goal is to find "hidden" contradictions or unjustified leaps in reasoning.\n\nAUDIT PROCESS:\n  1. Isolate every quantitative claim and the logic used to reach it.\n  2. Re-derive the result from the reported ground truth using first principles.\n  3. Check for "Tautological Reasoning": Are the conclusions merely repeating the premises?\n  4. Verify all units, dimensions, and scales for consistency.\n\nOutput ONLY valid JSON — no markdown fences, no prose:\n{"issues": [{"location": "exact text segment", "severity": "critical|major|minor", "type": "incorrect_equation|unjustified_step|missing_assumption|circular_reasoning|domain_error|other", "description": "...", "correction": "..."}], "hasMathContent": true, "mathRigorScore": 0}\nIf no math content is present, return {"issues": [], "hasMathContent": false, "mathRigorScore": 100}.`, `REPORT TO VERIFY:\n\n${report}`, { ...opts, samplingProfile: 'verify' });
    const parsed = parseJsonSafe(r.content || '', MathLogicSchema);
    if (parsed) {
        log({ level: 'info', msg: `[STEP 8B] Math/Logic: ${parsed.issues?.length ?? 0} issues found, score=${parsed.mathRigorScore ?? 'N/A'}`, source: 'researchAgent', ts: Date.now() });
        return { agent: 'mathLogic', ...parsed };
    }
    log({ level: 'warn', msg: '[STEP 8B] Math/Logic parse failed', source: 'researchAgent', ts: Date.now() });
    return { agent: 'mathLogic', issues: [], hasMathContent: false, mathRigorScore: 100 };
}
async function quantFinanceVerifier(callChat, report, opts = {}) {
    log({ level: 'info', msg: '[STEP 8E] Quant Finance Verifier starting...', source: 'researchAgent', ts: Date.now() });
    const r = await isolatedCall(callChat, `You are a Quantitative Finance Auditor. You re-derive every quantitative claim in an investment report from first principles.

MATH YOU MUST CHECK:
  1. Geometric Brownian motion: dS = μS dt + σS dW. Expected return over horizon T under GBM: E[S_T] = S_0 * e^(μT). Log-return variance: σ²T.
  2. Ito's lemma applications: for f(S) = ln S, df = (μ - σ²/2)dt + σ dW — the drift correction -σ²/2 must appear in any log-return derivation.
  3. Sharpe ratio: (R_p - R_f) / σ_p. Check the numbers actually divide correctly.
  4. VaR: z_α * σ * P * sqrt(T) for normal returns (z_0.95 = 1.645, z_0.99 = 2.326). Check the z-value matches the confidence level.
  5. DCF: PV = Σ CF_t / (1+r)^t. Check discount rates, growth rates, and terminal value math.
  6. Multiples: P/E, EV/EBITDA — check the numbers are consistent (price / EPS, etc.).
  7. Annualization: daily vol * sqrt(252) = annual vol. Monthly * sqrt(12).

CROSS-CHECK PROTOCOL (mandatory): every number in the report must be derivable
from the report's OWN stated inputs. For each of these, recompute and compare:
  - If the report states annualized volatility σ AND a 1-day 95% VaR, verify
    VaR = 1.645 * σ / sqrt(252). Example: σ = 42% implies 1-day 95% VaR =
    1.645 * 0.42 / 15.87 = 4.35%. A stated VaR of 3.4% with σ = 42% is an
    arithmetic_error — flag it and give the correct value.
  - If the report states a Sharpe ratio AND return AND volatility, verify
    Sharpe = (R_p - R_f) / σ_p.
  - If the report states a price target AND current price, verify the implied
    upside/downside percentage matches.
  - If the report states a forward P/E AND price AND EPS, verify P/E = price / EPS.

MISSING-MATH CHECKS (flag as critical, type "unsupported" or "missing_drift"):
  - If the report claims to have run a DCF or Monte Carlo simulation but never
    states the resulting intrinsic value estimate, flag it.
  - If the report mentions Ito's lemma or GBM but never applies it to compute
    an expected return or expected log-return (with the -σ²/2 drift
    correction), flag it.
  - If the report issues a buy/hold/sell recommendation, it must state the
    expected return and the risk (volatility) that justify it.

For every quantitative claim: state the formula, plug in the report's numbers, recompute, and compare. Flag any arithmetic error, wrong formula, wrong z-value, or missing drift correction.

Output ONLY valid JSON — no markdown fences, no prose:
{"issues": [{"location": "exact text segment", "severity": "critical|major|minor", "type": "arithmetic_error|wrong_formula|missing_drift|wrong_z_value|unit_error|unsupported", "description": "...", "correction": "..."}], "quantScore": 0, "hasQuantContent": true}
If no quantitative content is present, return {"issues": [], "quantScore": 100, "hasQuantContent": false}.`, `REPORT TO VERIFY:\n\n${report}`, { ...opts, samplingProfile: 'verify' });
    const parsed = parseJsonSafe(r.content || '', z.object({
        issues: z.array(z.object({ location: z.string().optional(), severity: z.string().optional(), type: z.string().optional(), description: z.string().optional(), correction: z.string().optional() })).optional(),
        quantScore: z.number().optional(),
        hasQuantContent: z.boolean().optional(),
    }));
    if (parsed) {
        log({ level: 'info', msg: `[STEP 8E] Quant: ${parsed.issues?.length ?? 0} issues found, score=${parsed.quantScore ?? 'N/A'}`, source: 'researchAgent', ts: Date.now() });
        return { agent: 'quantFinance', ...parsed };
    }
    log({ level: 'warn', msg: '[STEP 8E] Quant parse failed', source: 'researchAgent', ts: Date.now() });
    return { agent: 'quantFinance', issues: [], quantScore: 100, hasQuantContent: false };
}
async function domainExpertCritic(callChat, report, domainInfo, opts = {}) {
    log({ level: 'info', msg: `[STEP 8C] Domain Expert Critic starting (${domainInfo.domain})...`, source: 'researchAgent', ts: Date.now() });
    const rigorStandards = (domainInfo.keyRigorStandards || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n');
    const commonErrors = (domainInfo.commonErrors || []).map((e, i) => `  ${i + 1}. ${e}`).join('\n');
    const r = await isolatedCall(callChat, `${domainInfo.expertPersona}\n\nYou are conducting a rigorous formal peer review for a top-tier academic journal.\n\nCRITIQUE LENS:\n  - RIGOR: ${rigorStandards}\n  - COMMON PITFALLS: ${commonErrors}\n\nSTRUCTURAL CHECKS (flag as issues if violated):\n  - The report MUST begin with an Executive Summary that directly answers the question.\n  - Sections must not duplicate each other's content — if two sections repeat the same facts, flag the redundancy.\n  - The conclusion must directly answer the question with specifics (names, numbers, dates).\n\nYour goal is to identify "Intellectual Gaps"—where the report simplifies a complex reality or ignores a key counter-perspective.\n\nOutput ONLY valid JSON — no markdown fences, no prose:\n{"overallAssessment": "accept|major_revision|minor_revision|reject", "issues": [{"location": "...", "severity": "critical|major|minor", "type": "rigor|oversimplification|missing_caveat|scope_violation|terminology|overclaiming|other|structure", "description": "...", "recommendation": "..."}], "strengths": ["..."], "missingTopics": ["..."]}`, `REPORT UNDER PEER REVIEW:\n\n${report}`, { ...opts, samplingProfile: 'verify' });
    const parsed = parseJsonSafe(r.content || '', ExpertCritiqueSchema);
    if (parsed) {
        log({ level: 'info', msg: `[STEP 8C] Domain Expert: ${parsed.overallAssessment}, ${parsed.issues?.length ?? 0} issues found`, source: 'researchAgent', ts: Date.now() });
        return { agent: 'domainExpert', domainInfo, ...parsed };
    }
    log({ level: 'warn', msg: '[STEP 8C] Domain expert parse failed', source: 'researchAgent', ts: Date.now() });
    return { agent: 'domainExpert', domainInfo, overallAssessment: 'minor_revision', issues: [] };
}
async function adversarialCritic(callChat, report, topic, opts = {}) {
    log({ level: 'info', msg: '[STEP 8D] Adversarial Critic starting...', source: 'researchAgent', ts: Date.now() });
    const r = await isolatedCall(callChat, `You are a professional Devil's Advocate and Red-Team Auditor. Your goal is not to 'review' the report, but to systematically dismantle it by identifying fragile claims, confirmation bias, and logical leaps.\n\nATTACK VECTORS:\n  1. Fragile Claims: Identify assertions that rely on a single, potentially biased source or an outlier data point.\n  2. Confirmation Bias: Detect where the report ignored contradictory evidence to fit a pre-determined narrative.\n  3. Extrapolation Error: Flag instances where a narrow finding is presented as a broad trend.\n  4. Semantic Slippage: Find where terms are used inconsistently to bridge a logical gap.\n\nOutput ONLY valid JSON — no markdown fences, no prose:\n{"vulnerabilities": [{"claim": "exact quote", "attackVector": "...", "severity": "critical|major|minor", "counterEvidence": "...", "verdict": "likely_wrong|possibly_wrong|weak_support|acceptable"}], "weakestArgument": "...", "alternativeConclusion": "...", "overallVulnerabilityScore": 0}`, `REPORT TO ATTACK:\n\nTopic: ${topic}\n\n${report}`, { ...opts, samplingProfile: 'verify' });
    const parsed = parseJsonSafe(r.content || '', AdversarialSchema);
    if (parsed) {
        const critical = (parsed.vulnerabilities || []).filter((v) => v.verdict === 'likely_wrong' || v.verdict === 'possibly_wrong').length;
        log({ level: 'info', msg: `[STEP 8D] Adversarial: ${parsed.vulnerabilities?.length ?? 0} vulnerabilities, ${critical} critical, score=${parsed.overallVulnerabilityScore ?? 'N/A'}`, source: 'researchAgent', ts: Date.now() });
        return { agent: 'adversarial', ...parsed };
    }
    log({ level: 'warn', msg: '[STEP 8D] Adversarial parse failed', source: 'researchAgent', ts: Date.now() });
    return { agent: 'adversarial', vulnerabilities: [], weakestArgument: '', alternativeConclusion: '', overallVulnerabilityScore: 0 };
}
async function constrainedRepairAgent(callChat, report, allIssues, topic, opts = {}) {
    if (allIssues.length === 0) {
        log({ level: 'success', msg: '[STEP 9] No issues to repair — report accepted as-is', source: 'researchAgent', ts: Date.now() });
        return report;
    }
    log({ level: 'info', msg: `[STEP 9] Constrained Repair — fixing ${allIssues.length} flagged issues...`, source: 'researchAgent', ts: Date.now() });
    const issuesList = allIssues.map((issue, i) => {
        const lines = [`ISSUE ${i + 1} [${issue.severity?.toUpperCase() ?? 'UNKNOWN'}] from ${issue.agent}:`, `  Type: ${issue.type || 'general'}`, `  Problem: ${issue.description || issue.attackVector || 'See details'}`, `  Fix: ${issue.suggestion || issue.correction || issue.recommendation || 'Correct the issue as described'}`];
        if (issue.location || issue.claim)
            lines.push(`  Locator: "${issue.location || issue.claim || ''}"`);
        return lines.join('\n');
    }).join('\n\n');
    const r = await isolatedCall(callChat, `You are a Constrained Research Report Editor.\n\nYOUR CONSTRAINTS:\n  1. Fix ONLY the issues listed below. Do not change anything else.\n  2. Do NOT rewrite sections that have no issues.\n  3. Do NOT add new content beyond what is needed to fix the issues.\n  4. Do NOT remove citations or references.\n  5. Preserve all formatting, structure, and [Source N] citation tags.\n\nOutput the complete corrected report text ONLY — no preamble, no explanation.`, `RESEARCH TOPIC: ${topic}\n\nISSUES TO FIX:\n\n${issuesList}\n\n---\n\nORIGINAL REPORT:\n\n${report}`, { ...opts, think: true, samplingProfile: 'creative' });
    const repaired = (r.content || '').trim();
    if (repaired.length < report.length * 0.5) {
        log({ level: 'warn', msg: '[STEP 9] Repair produced suspiciously short output — keeping original', source: 'researchAgent', ts: Date.now() });
        return report;
    }
    log({ level: 'success', msg: `[STEP 9] Repair complete — ${repaired.length} chars (original: ${report.length})`, source: 'researchAgent', ts: Date.now() });
    return repaired;
}
async function critiqueAndRepairLoop(callChat, report, verifiedNodes, topic, opts = {}) {
    const maxLoops = opts.maxCritiqueLoops ?? 4;
    const issueThreshold = opts.critiqueThreshold ?? 2;
    const severityWeights = { critical: 3, major: 2, minor: 1 };
    const domainInfo = await detectResearchDomain(callChat, topic, opts);
    let currentReport = report;
    const critiqueHistory = [];
    for (let loop = 1; loop <= maxLoops; loop++) {
        log({ level: 'info', msg: `[CRITIQUE LOOP ${loop}/${maxLoops}] Running all critics in parallel...`, source: 'researchAgent', ts: Date.now() });
        const criticTasks = [
            sourceFidelityVerifier(callChat, currentReport, verifiedNodes, opts),
            mathLogicVerifier(callChat, currentReport, domainInfo, opts),
            domainExpertCritic(callChat, currentReport, domainInfo, opts),
            adversarialCritic(callChat, currentReport, topic, opts),
        ];
        if (opts.mode === 'stock')
            criticTasks.push(quantFinanceVerifier(callChat, currentReport, opts));
        const settledCritics = await Promise.allSettled(criticTasks);
        const critics = settledCritics.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const allIssues = [];
        for (const critic of critics) {
            for (const issue of critic.issues || [])
                allIssues.push({ ...issue, agent: critic.agent });
            for (const vuln of critic.vulnerabilities || []) {
                if (vuln.verdict === 'likely_wrong' || vuln.verdict === 'possibly_wrong') {
                    allIssues.push({ agent: 'adversarial', severity: vuln.verdict === 'likely_wrong' ? 'major' : 'minor', type: 'adversarial_vulnerability', description: vuln.attackVector, suggestion: `Address this vulnerability: ${vuln.counterEvidence}`, location: vuln.claim });
                }
            }
        }
        const issueScore = allIssues.reduce((sum, issue) => sum + (severityWeights[issue.severity] || 1), 0);
        const criticalCount = allIssues.filter((i) => i.severity === 'critical').length;
        log({ level: 'info', msg: `[CRITIQUE LOOP ${loop}] Total issues: ${allIssues.length} | Weighted score: ${issueScore} | Critical: ${criticalCount}`, source: 'researchAgent', ts: Date.now() });
        const expertCritic = critics.find((c) => c.agent === 'domainExpert');
        if (expertCritic?.overallAssessment)
            log({ level: 'info', msg: `[CRITIQUE LOOP ${loop}] Expert assessment: ${expertCritic.overallAssessment}`, source: 'researchAgent', ts: Date.now() });
        critiqueHistory.push({ loop, issueCount: allIssues.length, issueScore, criticalCount, expertAssessment: expertCritic?.overallAssessment });
        if (issueScore < issueThreshold && criticalCount === 0) {
            log({ level: 'success', msg: `[CRITIQUE LOOP ${loop}] Issue score below threshold (${issueScore} < ${issueThreshold}) — report accepted`, source: 'researchAgent', ts: Date.now() });
            break;
        }
        // convergence guard: if the last repair pass barely moved the score
        // (<20% improvement), more loops just burn calls — the report has
        // reached what this model can fix.
        const prevScore = critiqueHistory.length > 1 ? critiqueHistory[critiqueHistory.length - 2].issueScore : null;
        if (prevScore != null && issueScore >= prevScore * 0.8) {
            log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair converged (score ${prevScore} -> ${issueScore}, <20% improvement) — stopping`, source: 'researchAgent', ts: Date.now() });
            break;
        }
        allIssues.sort((a, b) => (severityWeights[b.severity] || 1) - (severityWeights[a.severity] || 1));
        currentReport = await constrainedRepairAgent(callChat, currentReport, allIssues, topic, opts);
        // repair agents are told to keep [Source N] tags — enforce it
        const refCount = new Set(verifiedNodes.map((n) => n.url)).size;
        const claimsByRef = new Map();
        const urlToId = new Map();
        let nextId = 1;
        for (const node of verifiedNodes) {
            if (!urlToId.has(node.url))
                urlToId.set(node.url, nextId++);
            const id = urlToId.get(node.url);
            if (!claimsByRef.has(id))
                claimsByRef.set(id, []);
            claimsByRef.get(id).push(node.claim);
        }
        const integrity = await enforceCitations(callChat, currentReport, refCount, claimsByRef, opts);
        if (integrity.restored.length)
            log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair dropped ${integrity.restored.length} citations — restored: [Source ${integrity.restored.join('], [Source ')}]`, source: 'researchAgent', ts: Date.now() });
        currentReport = integrity.report;
        if (expertCritic?.overallAssessment === 'accept') {
            log({ level: 'success', msg: `[CRITIQUE LOOP ${loop}] Expert accepts report — stopping critique loop`, source: 'researchAgent', ts: Date.now() });
            break;
        }
    }
    return { report: currentReport, critiqueHistory };
}
// ---- output format conversion ----
// the report is authored as markdown; outputFormat converts it at the end so
// the same pipeline serves markdown, plain text, JSON, and HTML consumers.
// conversions are mechanical (no LLM) so they can never damage citations.
function mdToPlain(md) {
    return String(md || '')
        .replace(/^#{1,6}\s+/gm, '') // headings
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1') // italic
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/^\s*[-*+]\s+/gm, '') // list bullets
        .replace(/^\s*\d+\.\s+/gm, '') // numbered list
        .replace(/`([^`]+)`/g, '$1') // inline code
        .replace(/\n{3,}/g, '\n\n');
}
function mdToHtml(md) {
    // full markdown renderer (headings, bold, links, lists, tables, code) —
    // marked is already a dependency, and the conversion is mechanical so
    // [Source N] citation tags pass through untouched.
    return marked.parse(String(md || ''), { gfm: true, breaks: false });
}
function mdToJson(md, topic, answerSpec, references) {
    const text = String(md || '');
    const sections = [];
    const re = /^##\s+(.*)$/gm;
    let last = null;
    let m;
    const body = text.split(re);
    // body[0] is preamble, then alternating title/content
    for (let i = 1; i < body.length; i += 2) {
        const title = body[i].trim();
        const content = body[i + 1]?.trim() || '';
        if (title.toLowerCase() === 'references')
            continue;
        sections.push({ title, content });
    }
    const refs = (references || []).map((r, i) => ({
        id: i + 1,
        title: r.title || '',
        url: r.url || '',
        source: r.site || r.source || '',
        date: r.year || r.publicationDate || r.date || '',
    }));
    return JSON.stringify({
        topic,
        answerType: answerSpec?.answerType || 'analysis',
        generatedAt: new Date().toISOString(),
        summary: body[0]?.trim() || '',
        sections,
        references: refs,
    }, null, 2);
}
function formatReport(report, opts, topic, answerSpec, references) {
    const fmt = String(opts.outputFormat || 'markdown').toLowerCase();
    if (fmt === 'plain')
        return mdToPlain(report);
    if (fmt === 'html')
        return mdToHtml(report);
    if (fmt === 'json')
        return mdToJson(report, topic, answerSpec, references);
    return report; // markdown (default) — pass through untouched
}
export default async function runDeepResearch(callChat, topic, opts = {}) {
    const stepSummary = {};
    if (opts.useOllamaSearch)
        log({ level: 'info', msg: '[CONFIG] Search backend: Ollama API', source: 'researchAgent', ts: Date.now() });
    else
        log({ level: 'info', msg: '[CONFIG] Search backend: SearXNG', source: 'researchAgent', ts: Date.now() });
    if (opts.academicFilter)
        log({ level: 'info', msg: '[CONFIG] Academic filter: ON', source: 'researchAgent', ts: Date.now() });
    if (opts.enableCritique !== false)
        log({ level: 'info', msg: '[CONFIG] Critique loop: ON', source: 'researchAgent', ts: Date.now() });
    try {
        let answerSpec = await detectAnswerFormat(callChat, topic, opts);
        if (opts.mode === 'stock') {
            answerSpec = { ...answerSpec, ...STOCK_SPEC };
            log({ level: 'info', msg: '[CONFIG] Stock research mode: fixed quant+fundamentals answer spec', source: 'researchAgent', ts: Date.now() });
        }
        stepSummary.step0 = { answerType: answerSpec.answerType, requiredFields: answerSpec.requiredFields };
        const queries = await plannerAgent(callChat, topic, answerSpec, opts);
        stepSummary.step1 = { queriesGenerated: queries.length };
        const rawResults = await crawlerAgent(queries, opts.maxConcurrency ?? 5, opts);
        stepSummary.step2 = { urlsRetrieved: rawResults.length };
        let verifiedSources = verificationAgent(rawResults, opts.credibilityThreshold ?? 35, opts);
        stepSummary.step3 = { urlsAfterFilter: verifiedSources.length };
        // local file support: user-supplied PDFs/docs/etc. are converted to
        // article text and injected as max-credibility sources, so they flow
        // through the same summarize → verify → cite path as web sources.
        if (opts.files && opts.files.length) {
            const localSources = await Promise.all(opts.files.map(async (f) => {
                try {
                    const content = await extractLocalFile(f);
                    const base = path.basename(f);
                    const abs = path.resolve(f).replace(/\\/g, '/');
                    return { url: 'file://' + abs, title: base, snippet: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300), cite: '', query: 'local file', goal: 'local file content', depth: 0, topic: 'local', localContent: content, credibilityScore: 100 };
                }
                catch (e) {
                    log({ level: 'error', msg: `[STEP 3] Local file failed: ${f} — ${e.message}`, source: 'researchAgent', ts: Date.now() });
                    return null;
                }
            }));
            const ok = localSources.filter(Boolean);
            if (ok.length) {
                verifiedSources = [...ok, ...verifiedSources];
                stepSummary.step3.localFiles = ok.length;
                log({ level: 'info', msg: `[STEP 3] Injected ${ok.length} local file source(s) at max credibility`, source: 'researchAgent', ts: Date.now() });
            }
        }
        if (verifiedSources.length === 0)
            return { report: `No credible sources found for: "${topic}". Try lowering credibilityThreshold or broadening queries.`, references: [], claimCount: 0, stepSummary, success: false };
        const maxSourcesToFetch = opts.maxSummaries ?? 20;
        const primarySources = verifiedSources.slice(0, maxSourcesToFetch);
        const fallbackPool = verifiedSources.slice(maxSourcesToFetch);
        const rankedSummaries = await extractWithFallback(callChat, primarySources, fallbackPool, topic, answerSpec, opts);
        const diverseSummaries = applyMMR(rankedSummaries, opts.maxSummaries ?? 20, opts.diversityLambda ?? 0.6);
        stepSummary.step4 = { extracted: rankedSummaries.length, afterMMR: diverseSummaries.length, fallbackPoolSize: fallbackPool.length };
        if (diverseSummaries.length === 0)
            return { report: `Content extraction failed for all sources on: "${topic}".`, references: [], claimCount: 0, stepSummary, success: false };
        const verifiedNodes = await factVerificationLoop(callChat, diverseSummaries, topic, opts);
        stepSummary.step5 = { verifiedClaims: verifiedNodes.length };
        if (verifiedNodes.length === 0)
            return { report: `All extracted claims failed factual verification for: "${topic}".`, references: [], claimCount: 0, stepSummary, success: false };
        // stock mode: compute the real quant model from the verified claims so
        // the report's DCF/GBM/VaR numbers are code-computed, not LLM-asserted.
        let quantModel = null;
        if (opts.mode === 'stock') {
            quantModel = runQuantModel(verifiedNodes.map((n) => n.claim));
            stepSummary.quant = {
                ok: quantModel.ok, intrinsicValue: quantModel.intrinsicValue,
                costOfEquity: quantModel.costOfEquity, sharpe: quantModel.sharpe,
                var95_1d: quantModel.var95_1d, expectedLogReturn: quantModel.expectedLogReturn,
                inputs: quantModel.inputs,
            };
            log({ level: quantModel.ok ? 'success' : 'warn', msg: `[QUANT] ${quantModel.ok ? 'Computed' : 'Partial'} model — IV $${quantModel.intrinsicValue?.toFixed(2) ?? 'n/a'}/share, Re ${quantModel.costOfEquity != null ? (quantModel.costOfEquity * 100).toFixed(2) + '%' : 'n/a'}, Sharpe ${quantModel.sharpe?.toFixed(2) ?? 'n/a'}`, source: 'researchAgent', ts: Date.now() });
        }
        const { report: initialReport, references, claimCount } = await reportWriterAgent(callChat, topic, answerSpec, verifiedNodes, opts, queries, quantModel);
        stepSummary.step6 = { reportLength: initialReport.length, uniqueSources: references.length };
        let finalReport = initialReport;
        let critiqueHistory = [];
        if (opts.enableCritique !== false) {
            const critiqueResult = await critiqueAndRepairLoop(callChat, initialReport, verifiedNodes, topic, opts);
            finalReport = critiqueResult.report;
            critiqueHistory = critiqueResult.critiqueHistory;
            stepSummary.steps789 = {
                critiqueLoops: critiqueHistory.length,
                totalIssuesFixed: critiqueHistory.reduce((sum, h) => sum + h.issueCount, 0),
                finalIssueScore: critiqueHistory.at(-1)?.issueScore ?? 0,
                expertAssessment: critiqueHistory.at(-1)?.expertAssessment ?? 'N/A',
                reportLengthDelta: finalReport.length - initialReport.length,
            };
            log({ level: 'success', msg: `[STEP 9] Critique loop complete — ${critiqueHistory.length} loops, final report: ${finalReport.length} chars`, source: 'researchAgent', ts: Date.now() });
        }
        // the computed quant section is appended AFTER the critique loop so no
        // critic/repair pass can rewrite code-computed math — it lands between
        // the conclusion and references as a modeling appendix.
        if (quantModel && quantModel.section) {
            const refIdx = finalReport.lastIndexOf('\n---\n## References');
            if (refIdx > -1)
                finalReport = finalReport.slice(0, refIdx) + '\n\n' + quantModel.section + finalReport.slice(refIdx);
            else
                finalReport += '\n\n' + quantModel.section;
            stepSummary.quant.injected = true;
            log({ level: 'success', msg: '[QUANT] Injected computed quantitative model section', source: 'researchAgent', ts: Date.now() });
        }
        // humanize flag: rewrite until the detector says 0% AI-ness, fixing any
        // damage each rewrite causes, looping until clean.
        if (opts.humanize) {
            log({ level: 'info', msg: '[HUMANIZE] Running humanize loop on final report...', source: 'researchAgent', ts: Date.now() });
            const h = await humanizeText(callChat, finalReport, opts);
            finalReport = h.text;
            stepSummary.humanize = { iterations: h.iterations, finalScore: h.finalScore, ok: h.ok };
            log({ level: 'success', msg: `[HUMANIZE] Done — ${h.iterations} iterations, detector score ${h.finalScore}`, source: 'researchAgent', ts: Date.now() });
        }
        log({ level: 'success', msg: '[DONE] Research complete. Final report delivered.', source: 'researchAgent', ts: Date.now() });
        const report = formatReport(finalReport, opts, topic, answerSpec, references);
        return { report, references, claimCount, stepSummary, critiqueHistory, success: true };
    }
    catch (e) {
        log({ level: 'error', msg: `[researchAgent] Fatal error: ${e.message}`, source: 'researchAgent', ts: Date.now() });
        return { report: `Research failed: ${e.message}`, references: [], claimCount: 0, stepSummary, success: false };
    }
}
export { detectAnswerFormat, plannerAgent, crawlerAgent, verificationAgent, scoreCredibility, extractAndSummarize, extractWithFallback, applyMMR, factVerificationLoop, reportWriterAgent, buildAPACitation, buildCoverageGapsDisclaimer, detectResearchDomain, sourceFidelityVerifier, mathLogicVerifier, domainExpertCritic, adversarialCritic, constrainedRepairAgent, critiqueAndRepairLoop, isolatedCall, mergeDuplicateClaims, DEFAULT_ACADEMIC_WHITELIST, DEFAULT_ACADEMIC_BLACKLIST, DEFAULT_NEGATIVE_URL_PATTERNS, };
