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
// Q&A spam farms (zhihu, baidu-zhidao, zybang, etc.) surface constantly in
// free-search fallbacks and never contain research-grade content — kill them
// hard so a bad instance can't poison a run like it did in run 5.
const QNA_SPAM_DOMAINS = new Set([
    'zhihu.com', 'baidu.com', 'baiduzhidao.com', 'zhidao.baidu.com', 'zybang.com',
    '360doc.com', 'wenku.baidu.com', 'jianshu.com', 'wukong.com', 'sohu.com',
    'xueqiu.com', 'guba.eastmoney.com', 'taoguba.com.cn', '9gag.com',
    'answers.yahoo.com', 'ask.fm', 'brainly.com', 'coursehero.com',
]);
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
4. Entity Targeting: Use queries that name-drop the predicted entity types.${opts.mode === 'stock' && opts.ticker ? `\n5. STOCK MODE: one depth-1 query MUST fetch the CURRENT share price/quote of ${opts.ticker} (e.g. "${opts.ticker} stock price today").` : ''}

Query budget: depth-0: ${d0count}, depth-1: ${d1count}, depth-2: ${d2count}

Output ONLY valid JSON — no markdown fences, no prose:
{"queries": [{"query": "search string", "goal": "exact information objective", "depth": 0|1|2, "topic": "sub-topic label"}]}

CRITICAL: Respond with RAW JSON ONLY. Start with '{' and end with '}'.` },
        { role: 'user', content: `Research topic: ${topic}` }], false, null, { ...opts, think: true, samplingProfile: 'planning' });
    const parsed = parseJsonSafe(r.content || '', PlannerPlanSchema);
    if (parsed) {
        const total = d0count + d1count + d2count;
        const sliced = parsed.queries.slice(0, total);
        // stock mode: a current-price query is non-negotiable — the quant
        // engine dies without it. the planner may or may not have included one;
        // make sure it exists deterministically instead of hoping (run 6 had 6
        // queries, zero about the price, so the whole quant model fell over).
        if (opts.mode === 'stock' && opts.ticker) {
            const hasQuote = sliced.some((q) => /quote|current price|share price|stock price|trading at|trades at/i.test(q.query));
            if (!hasQuote)
                sliced.unshift({ query: `${opts.ticker} stock price today current quote`, goal: 'Get the current market price of the stock', depth: 1, topic: 'current price' });
        }
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
        const batchResults = await Promise.allSettled(batch.map(async (item) => {
            // recoverStockQuote passes plain strings; plannerAgent passes
            // {query,goal,depth,topic} objects. run 14: destructuring a string
            // gave query=undefined, the search crashed on query.slice(), and the
            // recovery crawl silently returned 0 URLs — the quant model died.
            const { query, goal, depth, topic } = typeof item === 'string'
                ? { query: item, goal: '', depth: 0, topic: 'general' }
                : (item || {});
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
    // the CJK/Q&A penalties assume an ENGLISH research query — for a Chinese
    // topic zhihu/baidu ARE the authoritative sources, so skip the foreign-
    // language penalties entirely when the topic itself is CJK-heavy.
    const topicCjk = ((opts.topic || '').match(/[一-鿿㐀-䶿]/g) || []).length / Math.max(1, (opts.topic || '').length) > 0.3;
    try {
        const hostname = new URL(url).hostname;
        const tld2 = '.' + hostname.split('.').slice(-2).join('.');
        const tld1 = '.' + hostname.split('.').pop();
        if (HIGH_CREDIBILITY_TLDS.has(tld2))
            score += 30;
        else if (HIGH_CREDIBILITY_TLDS.has(tld1))
            score += 20;
        if (QNA_SPAM_DOMAINS.has(hostname) && !topicCjk)
            score -= 60;
    }
    catch {
        score -= 20;
    }
    const text = (snippet + ' ' + title).toLowerCase();
    // CJK title/snippet = the fallback search instance returned a foreign
    // Q&A page — dead weight for an English research query.
    const cjkRatio = (text.match(/[一-鿿㐀-䶿]/g) || []).length / Math.max(1, text.length);
    if (cjkRatio > 0.3 && !topicCjk)
        score -= 45;
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
    // CJK spam guard (run 5): the fallback search instance returned Chinese
    // Q&A pages (zhihu/baidu/zybang) that polluted the whole crawl. a page
    // this CJK-heavy is not research evidence for an English query — reject
    // before spending an extraction call on it. (a CJK-heavy TOPIC keeps the
    // pages: for Chinese research those sources are legitimate.)
    const topicCjk = ((topic || '').match(/[一-鿿㐀-䶿]/g) || []).length / Math.max(1, (topic || '').length) > 0.3;
    const cjkChars = (rawContent.match(/[一-鿿㐀-䶿]/g) || []).length;
    if (!topicCjk && cjkChars / Math.max(1, rawContent.length) > 0.2) {
        return { url, goal, summary: null, credibilityScore, error: 'Non-English (CJK) content' };
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
        // srcMeta keeps each source's own title/citation — a merged claim cites
        // 4 URLs, and each reference must carry ITS page's metadata, not the
        // first source's (run 7: 4 refs all titled "NVDA Stock Beta History").
        const merged = { ...a, urls: [a.url], srcMeta: [{ url: a.url, title: a.title, citation: a.citation, publicationDate: a.publicationDate }] };
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
                // dedupe URLs — the same source page can produce several claims that
                // all merge into one node, and run 15 shipped "[Source 1, Source 1,
                // Source 1...]" ×16 because the duplicate URLs all mapped to the
                // same ref id.
                if (!merged.urls.includes(b.url)) {
                    merged.urls.push(b.url);
                    merged.srcMeta.push({ url: b.url, title: b.title, citation: b.citation, publicationDate: b.publicationDate });
                }
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
        log({ level: 'warn', msg: '[STEP 6] Coverage gaps detected — disclaimer will be appended after the conclusion', source: 'researchAgent', ts: Date.now() });
    const deduped = mergeDuplicateClaims(verifiedNodes);
    if (deduped.length < verifiedNodes.length)
        log({ level: 'info', msg: `[STEP 6] Claim dedup: ${verifiedNodes.length} -> ${deduped.length}`, source: 'researchAgent', ts: Date.now() });
    const refMap = new Map();
    for (const node of deduped) {
        // merged claims carry per-URL metadata (srcMeta); everything else uses
        // the node's own. each URL gets ITS page's title/citation in the
        // References section — never a neighbor's.
        const metas = node.srcMeta && node.srcMeta.length
            ? node.srcMeta
            : (node.urls || [node.url]).map((u) => ({ url: u, title: node.title, citation: node.citation, publicationDate: node.publicationDate }));
        for (const m of metas) {
            if (refMap.has(m.url))
                continue;
            const cData = m.citation?.data || {};
            const siteFallback = (() => { try {
                const h = new URL(m.url).hostname;
                return h || (m.url.startsWith('file://') ? m.title : m.url);
            }
            catch {
                return m.url;
            } })();
            // login-wall pages yield 'Untitled' (sanitizeTitle) — fall back to a
            // URL-derived title so the References section still names the page
            // ("eps-diluted-ttm" → "EPS Diluted TTM").
            const urlTitle = (() => {
                try {
                    const seg = decodeURIComponent(new URL(m.url).pathname.split('/').filter(Boolean).pop() || '');
                    return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                }
                catch {
                    return '';
                }
            })();
            const title = cData.title && cData.title !== 'Untitled' ? cData.title : (m.title && m.title !== 'Untitled' ? m.title : (urlTitle || node.citedSummary || 'Untitled'));
            refMap.set(m.url, { id: refMap.size + 1, url: m.url, title, author: cData.author || '', year: cData.year || m.publicationDate || 'n.d.', site: cData.site || siteFallback });
        }
    }
    for (const [, ref] of refMap)
        ref.apa = buildAPACitation(ref);
    // theme-cluster the claims before chunking (run 15: 5 chunks × 4
    // subheadings each = 21 overlapping ## sections — "Industry Status
    // Quo" appeared in 3 different chunks because claims were chunked by
    // ORDER, not theme). one LLM call groups the claims into K thematic
    // clusters; each cluster becomes one section with a distinct theme.
    // every index must be covered exactly once — any drop falls back to
    // the original order.
    const k = Math.max(1, Math.ceil(deduped.length / chunk));
    let clustered = deduped;
    try {
        const cR = await callChat([{ role: 'system', content: `You are a research librarian. Group the given claims into ${k} thematic clusters. Each cluster must have a DISTINCT theme (e.g. "Financial Performance", "Competitive Moat", "Industry Outlook" — never two clusters on the same theme). Every claim index must appear in EXACTLY ONE cluster. Output ONLY valid JSON — no markdown fences:\n[{"theme": "short theme name", "indices": [0, 2, 5]}]` },
            { role: 'user', content: `CLAIMS:\n${deduped.map((n, i) => `[${i}] ${n.claim}`).join('\n')}` }], false, null, { ...opts, think: false, samplingProfile: 'json' });
        const parsed = parseJsonSafe(cR.content || '', z.array(z.object({ theme: z.string(), indices: z.array(z.number()) })));
        if (parsed) {
            const seen = new Set();
            const ordered = [];
            for (const cl of parsed) {
                for (const idx of cl.indices) {
                    if (idx >= 0 && idx < deduped.length && !seen.has(idx)) {
                        seen.add(idx);
                        ordered.push(deduped[idx]);
                    }
                }
            }
            if (seen.size === deduped.length) {
                clustered = ordered;
                log({ level: 'info', msg: `[STEP 6] Theme-clustered ${deduped.length} claims into ${parsed.length} groups`, source: 'researchAgent', ts: Date.now() });
            }
            else {
                log({ level: 'warn', msg: `[STEP 6] Theme clustering covered ${seen.size}/${deduped.length} claims — using original order`, source: 'researchAgent', ts: Date.now() });
            }
        }
    }
    catch (e) {
        log({ level: 'warn', msg: `[STEP 6] Theme clustering failed (${e.message}) — using original order`, source: 'researchAgent', ts: Date.now() });
    }
    const chunks = [];
    for (let i = 0; i < clustered.length; i += chunk)
        chunks.push(clustered.slice(i, i + chunk));
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
    else if (opts.mode === 'stock') {
        // engine couldn't compute (missing price/EPS/beta in claims): the writer
        // MUST NOT invent math to fill the gap — that is how "Merton
        // jump-diffusion" hallucinations enter reports.
        quantNote = `\n\nTHE PIPELINE COULD NOT COMPUTE A QUANTITATIVE MODEL — the verified claims are missing inputs (current price, EPS, beta, or growth). Do NOT invent quantitative models (no Monte Carlo, no jump-diffusion, no unstated DCF values, no invented expected returns, Sharpe ratios, or VaR figures). State ONLY what the cited sources support, and attribute every number to its source.`;
    }
    const stockNote = opts.mode === 'stock'
        ? `\n\nSTOCK REPORT REQUIREMENTS (non-negotiable):\n  - If you run a DCF or Monte Carlo, STATE the resulting intrinsic value estimate in dollars per share.\n  - Apply Ito's lemma concretely: derive the expected log-return (μ - σ²/2)T and use it in your expected-return math. Do not just name-drop the equation.\n  - Every risk metric (VaR, Sharpe) must be consistent with the stated volatility: 1-day 95% VaR = 1.645 * σ / sqrt(252).\n  - State the expected return over your target horizon and the volatility that justifies the recommendation.${quantNote}`
        : '';
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunkSlice = chunks[ci];
        const isFirst = ci === 0;
        const taggedClaims = chunkSlice.map((node) => {
            const refIds = [...new Set((node.urls || [node.url]).map((u) => refMap.get(u)?.id ?? '?'))];
            const pubTag = node.publicationDate && node.publicationDate !== 'unknown' ? ` [published ${node.publicationDate}]` : '';
            return `[Source ${refIds.join(', Source ')}${pubTag}] ${node.claim}`;
        }).join('\n');
        const continuityNote = isFirst ? `Begin with a 3-sentence Executive Summary answering: "${topic}"` : `Continue the report seamlessly. The previous section ended with:\n"...${previousTail}"`;
        const r = await callChat([{ role: 'system', content: `You are writing section ${ci + 1} of ${chunks.length} of a research report.\n\nORIGINAL QUESTION: "${topic}"\n${requiredNote}\n${timeNote}${stockNote}\n\nSECTION RULES:\n  1. Write complete, detailed prose for EVERY claim — do not skip any.\n  2. Do NOT save tokens. Do NOT summarize. Write fully.\n  3. Keep every [Source N] inline citation tag exactly as given.\n  4. Use ### subheadings to group claims by theme (the ## level is reserved for the report's top-level sections).\n  5. Do NOT write a conclusion — that comes in the final section.\n  6. Do NOT write a references section.\n  7. Do NOT repeat content from the previous section.\n  8. Each [Source N] tag includes a published date. When citing historical data,\n     clearly label it: "As of [date], ...". Do NOT present old data as current.\n\n${continuityNote}` },
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
    // coverage-gaps disclaimer goes AFTER the conclusion, not before the exec
    // summary — run 15 shipped "## Coverage Gaps" as the report's first section,
    // violating the "Executive Summary must lead" structural rule. transparency
    // is kept, placement is fixed.
    const preamble = '';
    const gapsTail = coverageGaps ? '\n\n---\n' + coverageGaps.replace(/\n---\s*$/, '') : '';
    let fullReport = concatenated + '\n\n---\n## Conclusion\n\n' + conclusion + gapsTail + refsSection;
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
async function quantFinanceVerifier(callChat, report, opts = {}, quantModel = null) {
    log({ level: 'info', msg: '[STEP 8E] Quant Finance Verifier starting...', source: 'researchAgent', ts: Date.now() });
    // when the quant engine computed values, the verifier gets ground truth to
    // check the report against — a deterministic anchor instead of vibes.
    const groundTruth = quantModel && quantModel.ok
        ? `\nPIPELINE GROUND TRUTH (computed deterministically by the research pipeline's quant engine from the verified claims — the report MUST be consistent with these):\n` +
            `  - Price: $${quantModel.price.toFixed(2)}\n` +
            `  - EPS: $${quantModel.eps.toFixed(2)}\n` +
            `  - Growth: ${(quantModel.growth * 100).toFixed(1)}%\n` +
            `  - Beta: ${quantModel.beta ?? 1.0}${quantModel.beta == null ? ' (assumed — market average, not in sources)' : ''}\n` +
            `  - Cost of equity (CAPM): ${(quantModel.costOfEquity * 100).toFixed(2)}%\n` +
            `  - Volatility: ${(quantModel.sigma * 100).toFixed(1)}%\n` +
            `  - Intrinsic value (10-yr DCF): $${quantModel.intrinsicValue.toFixed(2)}/share\n` +
            `  - Expected return μ: ${(quantModel.expectedReturn * 100).toFixed(1)}%, log-return (μ-σ²/2): ${(quantModel.expectedLogReturn * 100).toFixed(1)}%\n` +
            `  - Sharpe: ${quantModel.sharpe.toFixed(3)}, 1-day 95% VaR: $${quantModel.var95_1d.toFixed(2)} (${((quantModel.var95_1d / quantModel.price) * 100).toFixed(2)}%), 1-day 99% VaR: $${quantModel.var99_1d.toFixed(2)}, 1-yr 95% VaR: $${quantModel.var95_1y.toFixed(2)}\n` +
            `  - Expected price in 1 year: $${quantModel.expectedPrice.toFixed(2)}\n` +
            `Any number the report states for these quantities that differs from the ground truth is an arithmetic_error with the ground-truth value as the correction. Any model the report claims to have run that the pipeline did not (Monte Carlo, jump-diffusion, etc.) is "unsupported".`
        : `\nNo pipeline-computed ground truth is available — verify the report against its own stated inputs as described below, and flag any claimed model (Monte Carlo, jump-diffusion, DCF) that has no stated intrinsic value or applied derivation as "unsupported".`;
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
If no quantitative content is present, return {"issues": [], "quantScore": 100, "hasQuantContent": false}.${groundTruth}`, `REPORT TO VERIFY:\n\n${report}`, { ...opts, samplingProfile: 'verify' });
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
async function critiqueAndRepairLoop(callChat, report, verifiedNodes, topic, opts = {}, quantModel = null) {
    const maxLoops = opts.maxCritiqueLoops ?? 4;
    const issueThreshold = opts.critiqueThreshold ?? 2;
    const severityWeights = { critical: 3, major: 2, minor: 1 };
    const domainInfo = await detectResearchDomain(callChat, topic, opts);
    let currentReport = report;
    // best-report tracking: repair passes can REGRESS (run 7: 54 -> 28 -> 39
    // — the third pass made things worse). keep the best-scoring version and
    // restore it when the loop stalls or the cap is hit.
    let bestReport = report;
    let bestScore = Infinity;
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
            criticTasks.push(quantFinanceVerifier(callChat, currentReport, opts, quantModel));
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
        if (issueScore < bestScore) {
            bestScore = issueScore;
            bestReport = currentReport;
        }
        if (issueScore < issueThreshold && criticalCount === 0) {
            log({ level: 'success', msg: `[CRITIQUE LOOP ${loop}] Issue score below threshold (${issueScore} < ${issueThreshold}) — report accepted`, source: 'researchAgent', ts: Date.now() });
            break;
        }
        // citation integrity data — computed once per loop, used by both the
        // normal repair and the regression retry below
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
        // convergence guard: if the last repair pass barely moved the score
        // (<20% improvement), more loops just burn calls — the report has
        // reached what this model can fix. a REGRESSION (score went up) means
        // the pass made it worse: restore the best-scoring version, don't ship
        // the damage.
        const prevScore = critiqueHistory.length > 1 ? critiqueHistory[critiqueHistory.length - 2].issueScore : null;
        if (prevScore != null && issueScore > prevScore) {
            // regression retry: the full repair pass made things worse (run 14:
            // 37 -> 54). restore the best report and retry with a SURGICAL pass
            // that fixes only the critical issues — a smaller issue list means a
            // smaller rewrite, which means less chance of introducing new damage.
            const criticals = allIssues.filter((i) => i.severity === 'critical');
            if (criticals.length && loop < maxLoops) {
                log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair regressed (${prevScore} -> ${issueScore}) — surgical retry on ${criticals.length} critical issues only`, source: 'researchAgent', ts: Date.now() });
                currentReport = bestReport;
                const surgical = await constrainedRepairAgent(callChat, currentReport, criticals, topic, opts);
                const integrity2 = await enforceCitations(callChat, surgical, refCount, claimsByRef, opts);
                if (integrity2.restored.length)
                    log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Surgical repair dropped ${integrity2.restored.length} citations — restored: [Source ${integrity2.restored.join('], [Source ')}]`, source: 'researchAgent', ts: Date.now() });
                currentReport = integrity2.report;
                continue; // re-critique the surgical result next loop
            }
            log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair regressed (score ${prevScore} -> ${issueScore}) — restoring best report (score ${bestScore})`, source: 'researchAgent', ts: Date.now() });
            currentReport = bestReport;
            break;
        }
        if (prevScore != null && issueScore >= prevScore * 0.8) {
            log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair converged (score ${prevScore} -> ${issueScore}, <20% improvement) — restoring best report (score ${bestScore})`, source: 'researchAgent', ts: Date.now() });
            currentReport = bestReport;
            break;
        }
        allIssues.sort((a, b) => (severityWeights[b.severity] || 1) - (severityWeights[a.severity] || 1));
        currentReport = await constrainedRepairAgent(callChat, currentReport, allIssues, topic, opts);
        const integrity = await enforceCitations(callChat, currentReport, refCount, claimsByRef, opts);
        if (integrity.restored.length)
            log({ level: 'warn', msg: `[CRITIQUE LOOP ${loop}] Repair dropped ${integrity.restored.length} citations — restored: [Source ${integrity.restored.join('], [Source ')}]`, source: 'researchAgent', ts: Date.now() });
        currentReport = integrity.report;
        if (expertCritic?.overallAssessment === 'accept') {
            log({ level: 'success', msg: `[CRITIQUE LOOP ${loop}] Expert accepts report — stopping critique loop`, source: 'researchAgent', ts: Date.now() });
            break;
        }
    }
    // loop cap hit with a regressed final pass — ship the best version seen.
    const lastScore = critiqueHistory.at(-1)?.issueScore ?? Infinity;
    if (lastScore > bestScore) {
        log({ level: 'warn', msg: `[CRITIQUE LOOP] Loop cap reached with regression (final ${lastScore} vs best ${bestScore}) — shipping best report`, source: 'researchAgent', ts: Date.now() });
        currentReport = bestReport;
    }
    return { report: currentReport, critiqueHistory };
}
// quantConformanceRepair — deterministic numeric-alignment sweep (run 8).
// the quant verifier flags prose numbers that contradict the engine, but
// LLM repair oscillates (run 7: 54 -> 28 -> 39) instead of converging to
// the ground truth. when the engine computed a model, the pipeline ENFORCES
// its numbers: every metric-anchored number in the report gets replaced
// with the engine's value. zero LLM in this step — code-computed truth,
// code-enforced. runs before the critique loop (critics verify the aligned
// report) and once more after it (repair may re-introduce divergence).
function quantConformanceRepair(report, quantModel) {
    if (!quantModel || !quantModel.ok)
        return report;
    // the References section is METADATA (titles, years, URLs) — never sweep
    // it. run 8: the beta rule matched "beta" inside a URL and rewrote "[5]"
    // into "[2.21]". split there and only touch the body.
    const refIdx = report.search(/\n---\n## References|\n## References/i);
    let head = refIdx > -1 ? report.slice(0, refIdx) : report;
    const tail = refIdx > -1 ? report.slice(refIdx) : '';
    const q = quantModel;
    const R = (v, d = 2) => v != null ? v.toFixed(d) : null;
    // Rpc — the engine stores rates as decimals (0.1449 = 14.49%), prose uses %
    const Rpc = (v, d = 1) => v != null ? (v * 100).toFixed(d) : null;
    // banned words disqualify a match: "price target of $180" is never the
    // current price, "volatility drag" is a different metric, and quarterly
    // EPS must never be rewritten to the annual figure.
    const PRICE_BAN = ['target', 'forecast', 'guidance', 'projection', 'estimate', 'expect', 'range', 'high', 'low', 'week', 'year', 'times', 'multiple'];
    const EPS_BAN = ['q1', 'q2', 'q3', 'q4', 'quarter', 'quarterly'];
    const rules = [
        // current/market/share/stock price — the consensus quote, never a target.
        // $ is optional ("trading at a current price of 218.14 USD"); the trailing
        // window pulls the %-and-banned-word context ("fell 5% to $210", "closed
        // at 52-week high of $150") INTO the match so the guards can see it; the
        // strict decimal capture stops "2021." from swallowing the sentence
        // period; the year-guard keeps years.
        { re: /(?:current|market|share|stock|trading|last)\s+price[^$\n]{0,40}?\$?([\d,]+(?:\.\d+)?)[^$\n]{0,15}/gi, banned: PRICE_BAN, fn: (m, n) => {
                const i = m.indexOf(n);
                return (i > -1 && (m[i + n.length] === '%' || m[i + n.length] === 'x')) || /^(19|20)\d{2}$/.test(n) ? null : (R(q.price) && n !== R(q.price) ? R(q.price) : null);
            } },
        // price actions ("closed at $217.55", "trades at $150.42") — "trades at
        // 27 times forward earnings" is a P/E multiple, never a price (run 11)
        { re: /(?:trades? at|trading at|closed at|currently trading at|currently sits at|quoted at|price (?:is|of))[^$\n]{0,30}?\$?([\d,]+(?:\.\d+)?)[^$\n]{0,15}/gi, banned: PRICE_BAN, fn: (m, n) => {
                const i = m.indexOf(n);
                return (i > -1 && (m[i + n.length] === '%' || m[i + n.length] === 'x')) || /^(19|20)\d{2}$/.test(n) ? null : (R(q.price) && n !== R(q.price) ? R(q.price) : null);
            } },
        // EPS — trailing context so "EPS of $1.30 for Q3" is caught by the ban;
        // %-guard stops "EPS growth of 5%" from grabbing the growth number
        { re: /(?:EPS|earnings per share)[^$\n]{0,40}?\$?([\d,]+\.\d{2})[^$\n]{0,25}/gi, banned: EPS_BAN, fn: (m, n) => {
                const i = m.indexOf(n);
                return (i > -1 && m[i + n.length] === '%') || /^(19|20)\d{2}$/.test(n) ? null : (R(q.eps) && n !== R(q.eps) ? R(q.eps) : null);
            } },
        // beta (same windowed anchors as the engine)
        { re: /(?:beta|Beta)\s+(?:of|at|is|:|=)\s*([\d.]+)/gi, banned: [], fn: (_m, n) => R(q.beta) && n !== R(q.beta) ? R(q.beta) : null },
        { re: /(?:beta|Beta)(?:\s*\([^)]*\)|[^0-9]){0,40}([\d.]+)/gi, banned: [], fn: (_m, n) => R(q.beta) && n !== R(q.beta) ? R(q.beta) : null },
        // volatility — "volatility drag" is σ²/2, a different engine metric.
        // capture excludes the trailing %, so fn returns the bare number.
        { re: /(?:volatility|annualized volatility)[^%0-9]{0,40}?([\d.]+)\s*%/gi, banned: ['drag'], fn: (_m, n) => Rpc(q.sigma, 1) && n !== Rpc(q.sigma, 1) ? Rpc(q.sigma, 1) : null },
        // cost of equity / discount rate / WACC — the DCF discount rate is Re
        { re: /(?:cost of equity|discount rate|WACC)[^%0-9]{0,40}?([\d.]+)\s*%/gi, banned: [], fn: (_m, n) => Rpc(q.costOfEquity, 2) && n !== Rpc(q.costOfEquity, 2) ? Rpc(q.costOfEquity, 2) : null },
        // intrinsic value (DCF output)
        { re: /intrinsic value[^$\n]{0,40}?\$([\d,]+\.?\d*)/gi, banned: [], fn: (_m, n) => R(q.intrinsicValue) && n !== R(q.intrinsicValue) ? R(q.intrinsicValue) : null },
        // forward price E[S_T] — "expected price of $X in one year" (run 8's
        // writer said "expected MEAN price of $217.55" — S0 instead of E[S_T])
        { re: /expected (?:mean )?price[^$\n]{0,40}?\$?([\d,]+(?:\.\d+)?)/gi, banned: ['target'], fn: (m, n) => {
                const i = m.indexOf(n);
                return (i > -1 && m[i + n.length] === '%') || /^(19|20)\d{2}$/.test(n) ? null : (R(q.expectedPrice) && n !== R(q.expectedPrice) ? R(q.expectedPrice) : null);
            } },
        // expected returns — log-return FIRST (its own rule), then plain μ
        { re: /expected log-return[^%0-9]{0,30}?([\d.]+)\s*%/gi, banned: [], fn: (_m, n) => Rpc(q.expectedLogReturn, 1) && n !== Rpc(q.expectedLogReturn, 1) ? Rpc(q.expectedLogReturn, 1) : null },
        { re: /expected (?:annual )?return[^%0-9]{0,30}?([\d.]+)\s*%/gi, banned: [], fn: (_m, n) => Rpc(q.expectedReturn, 1) && n !== Rpc(q.expectedReturn, 1) ? Rpc(q.expectedReturn, 1) : null },
        // Sharpe
        { re: /Sharpe[^0-9]{0,30}?([\d.]+)/gi, banned: [], fn: (_m, n) => R(q.sharpe) && n !== R(q.sharpe) ? R(q.sharpe) : null },
        // VaR — specific horizons first, then bare VaR. the bare rule's negative
        // lookbehinds skip VaRs already qualified by a horizon, and the optional
        // trailing parens ("VaR of $12.05 (1-day 99%)") carry the qualifier the
        // sniff needs — a greedy trailing window would drag in the NEXT VaR
        // phrase and mis-target (run 8: "$12.05 ... 1-year ..." -> 135.24).
        { re: /1-day\s*95\s*%?\s*VaR[^$\n]{0,30}?\$([\d,]+\.?\d*)/gi, banned: [], fn: (_m, n) => R(q.var95_1d) && n !== R(q.var95_1d) ? R(q.var95_1d) : null },
        { re: /1-day\s*99\s*%?\s*VaR[^$\n]{0,30}?\$([\d,]+\.?\d*)/gi, banned: [], fn: (_m, n) => R(q.var99_1d) && n !== R(q.var99_1d) ? R(q.var99_1d) : null },
        { re: /1-year\s*95\s*%?\s*VaR[^$\n]{0,30}?\$([\d,]+\.?\d*)/gi, banned: [], fn: (_m, n) => R(q.var95_1y) && n !== R(q.var95_1y) ? R(q.var95_1y) : null },
        { re: /(?<!1-day\s*(?:95|99)\s*%?\s*)(?<!1-year\s*95\s*%?\s*)\bVaR\b[^$\n]{0,30}?\$([\d,]+\.?\d*)(?:\s*\(([^)]*)\))?/gi, banned: [], fn: (m, n) => {
                const ctx = m.toLowerCase();
                const target = /99/.test(ctx) ? q.var99_1d : /year|1y/.test(ctx) ? q.var95_1y : q.var95_1d;
                const s = R(target);
                return s && n !== s ? s : null;
            } },
    ];
    for (const rule of rules) {
        // run against head only — the references tail never passes a rule
        head = head.replace(rule.re, (m, num) => {
            if (rule.banned?.some((w) => m.toLowerCase().includes(w)))
                return m;
            const rep = rule.fn(m.toLowerCase(), num.replace(/,/g, ''));
            return rep != null ? m.replace(num, rep) : m;
        });
    }
    return head + tail;
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
// stock mode safety net: if the main crawl missed the current price, one
// targeted quote query can rescue the whole quant model — without a price
// the DCF, VaR, and expected-price math all stay uncomputable and the
// writer is forced into inventing numbers.
async function recoverStockQuote(callChat, topic, opts = {}, missing = []) {
    const ticker = opts.ticker || '';
    // bare tickers are ambiguous — run 17: "NVDA stock price today" returned
    // nvaccess.org (the NVDA screen-reader software), not NVIDIA. always pair
    // the ticker with the company name when we have it.
    const name = opts.companyName || ticker;
    // several phrasings per missing field — quote pages vary ("price",
    // "quote", "live", "now") and the fallback search instance is literal;
    // one phrasing can 404. run 10: the main crawl surfaced only industry
    // articles, so price/EPS/beta were all missing — recover each one.
    const queries = [];
    if (missing.includes('price') || !missing.length) {
        queries.push(`${name} (${ticker}) stock price today`, `${name} ${ticker} current share price quote`, `${name} ${ticker} stock quote live now`, `${name} ${ticker} last close price`);
    }
    if (missing.includes('eps'))
        queries.push(`${name} ${ticker} diluted EPS trailing twelve months`, `${name} ${ticker} earnings per share TTM`);
    if (missing.includes('beta'))
        queries.push(`${name} ${ticker} beta 5 year monthly`, `${name} ${ticker} stock beta volatility`, `${name} ${ticker} beta coefficient`, `${ticker} beta stockanalysis`);
    if (!queries.length)
        queries.push(`${topic} current price quote`);
    log({ level: 'info', msg: `[QUANT] Recovering: targeted quote crawl (${queries.length} phrasings for: ${missing.join(', ') || 'all'})`, source: 'researchAgent', ts: Date.now() });
    try {
        const results = await crawlerAgent(queries, 4, opts);
        // quote aggregators are low-DA pages — threshold 25 instead of 30 so
        // stockanalysis/marketwatch/yahoo actually make it through
        const credible = verificationAgent(results, 25, opts).slice(0, 6);
        if (!credible.length)
            return [];
        const sums = await extractWithFallback(callChat, credible, [], topic, { requiredFields: ['current stock price', 'EPS', 'beta', 'revenue growth'] }, { ...opts, maxSummaries: 3 });
        if (!sums.length)
            return [];
        // wrong-company guard: run 17's recovery crawl returned the NVDA screen
        // reader (nvaccess.org) — its claims mention "NVDA" (the product name)
        // but no stock terms, and they'd pollute the claim pool. keep a summary
        // only if it names the company, or names the ticker AND reads like a
        // stock page ($, price, share, EPS, market...).
        const nameL = name.toLowerCase();
        const tickL = ticker.toLowerCase();
        const STOCK_TERMS = /\$|price|share|eps|stock|market|dividend|revenue|earnings|beta|volatility|analyst|target|valuation/i;
        const onTopic = sums.filter((s) => {
            const t = String(s.summary || s.content || '').toLowerCase();
            if (nameL !== tickL && t.includes(nameL))
                return true;
            return t.includes(tickL) && STOCK_TERMS.test(t);
        });
        if (onTopic.length < sums.length) {
            log({ level: 'warn', msg: `[QUANT] Recovery dropped ${sums.length - onTopic.length} off-topic summaries (wrong company?)`, source: 'researchAgent', ts: Date.now() });
        }
        if (!onTopic.length)
            return [];
        return await factVerificationLoop(callChat, onTopic.slice(0, 3), topic, opts);
    }
    catch (e) {
        log({ level: 'warn', msg: `[QUANT] Quote recovery failed: ${e.message}`, source: 'researchAgent', ts: Date.now() });
        return [];
    }
}
export default async function runDeepResearch(callChat, topic, opts = {}) {
    // thread the topic through opts so language-aware guards (CJK penalties)
    // can decide per-query instead of blanket-rejecting non-English content
    opts = { ...opts, topic };
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
        // spam quarantine retry (run 5): the crawl came back but every result was
        // junk (Q&A spam, CJK pages) and got filtered out. one retry with the
        // known spam domains excluded — cheap, and turns a dead run into a run.
        if (verifiedSources.length === 0 && rawResults.length > 0) {
            const exclusions = Array.from(QNA_SPAM_DOMAINS).map((d) => `-site:${d}`).join(' ');
            const retryQueries = queries.map((q) => ({ ...q, query: `${q.query} ${exclusions}`.trim() }));
            log({ level: 'info', msg: `[STEP 3] All ${rawResults.length} results filtered as low-credibility — retrying crawl with spam domains excluded`, source: 'researchAgent', ts: Date.now() });
            const retryResults = await crawlerAgent(retryQueries, Math.max(2, opts.maxConcurrency ?? 5), opts);
            verifiedSources = verificationAgent(retryResults, opts.credibilityThreshold ?? 35, opts);
            stepSummary.step3 = { urlsAfterFilter: verifiedSources.length, retried: true };
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
            const preRecovery = verifiedNodes.length;
            quantModel = runQuantModel(verifiedNodes.map((n) => n.claim));
            // missing inputs = no math: one targeted quote crawl per missing
            // field (price, EPS, beta) before giving up
            const missing = ['price', 'eps', 'beta'].filter((k) => quantModel[k] == null);
            if (missing.length) {
                const extra = await recoverStockQuote(callChat, topic, opts, missing);
                if (extra.length) {
                    verifiedNodes.push(...extra);
                    quantModel = runQuantModel(verifiedNodes.map((n) => n.claim));
                    const still = ['price', 'eps', 'beta'].filter((k) => quantModel[k] == null);
                    log({ level: still.length ? 'warn' : 'success', msg: `[QUANT] Recovery added ${extra.length} claims — still missing: ${still.join(', ') || 'none'}`, source: 'researchAgent', ts: Date.now() });
                }
            }
            stepSummary.quant = {
                ok: quantModel.ok, intrinsicValue: quantModel.intrinsicValue,
                costOfEquity: quantModel.costOfEquity, sharpe: quantModel.sharpe,
                var95_1d: quantModel.var95_1d, expectedLogReturn: quantModel.expectedLogReturn,
                inputs: quantModel.inputs, recoveredClaims: verifiedNodes.length - preRecovery,
            };
            log({ level: quantModel.ok ? 'success' : 'warn', msg: `[QUANT] ${quantModel.ok ? 'Computed' : 'Partial'} model — IV $${quantModel.intrinsicValue?.toFixed(2) ?? 'n/a'}/share, Re ${quantModel.costOfEquity != null ? (quantModel.costOfEquity * 100).toFixed(2) + '%' : 'n/a'}, Sharpe ${quantModel.sharpe?.toFixed(2) ?? 'n/a'}`, source: 'researchAgent', ts: Date.now() });
        }
        let { report: initialReport, references, claimCount } = await reportWriterAgent(callChat, topic, answerSpec, verifiedNodes, opts, queries, quantModel);
        stepSummary.step6 = { reportLength: initialReport.length, uniqueSources: references.length };
        // quant conformance (pre-critique): align the writer's prose numbers
        // with the computed model BEFORE the critics see the report, so the
        // critique loop verifies the aligned version instead of flagging the
        // divergence. deterministic — no LLM.
        if (opts.mode === 'stock' && quantModel && quantModel.ok) {
            const aligned = quantConformanceRepair(initialReport, quantModel);
            if (aligned !== initialReport)
                log({ level: 'warn', msg: '[QUANT] Pre-critique conformance sweep aligned prose numbers with the computed model', source: 'researchAgent', ts: Date.now() });
            initialReport = aligned;
        }
        let finalReport = initialReport;
        let critiqueHistory = [];
        if (opts.enableCritique !== false) {
            const critiqueResult = await critiqueAndRepairLoop(callChat, initialReport, verifiedNodes, topic, opts, quantModel);
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
        // quant conformance (post-critique): repair passes can re-introduce
        // writer-style numbers — one final deterministic sweep locks the engine's
        // values into the shipped report.
        if (opts.mode === 'stock' && quantModel && quantModel.ok) {
            const aligned = quantConformanceRepair(finalReport, quantModel);
            if (aligned !== finalReport)
                log({ level: 'warn', msg: '[QUANT] Post-critique conformance sweep realigned prose numbers', source: 'researchAgent', ts: Date.now() });
            finalReport = aligned;
        }
        // invented-math purge (run 6): when the quant engine could NOT compute,
        // the writer sometimes fabricates GBM/VaR/Sharpe numbers anyway — the
        // anti-hallucination note is a prompt, not a guarantee. after the
        // critics have had their say, strip any model-math claims with one
        // strict repair pass so the shipped report never carries invented math.
        if (quantModel && !quantModel.ok && opts.mode === 'stock') {
            const MATH_TOKENS = [/Sharpe/i, /\bVaR\b/i, /Geometric Brownian/i, /\bGBM\b/i, /Ito'?s|Itô|Ito lemma/i, /drift correction/i, /volatility drag/i, /Monte Carlo/i, /jump[- ]diffusion/i, /Black[- ]Scholes/i, /implied volatility/i, /\bCAPM\b/i, /cost of equity/i, /intrinsic value/i, /discounted cash flow/i, /\bDCF\b/i, /expected log-return/i, /risk-adjusted/i];
            const mathHits = MATH_TOKENS.filter((t) => t.test(finalReport));
            if (mathHits.length) {
                log({ level: 'warn', msg: `[QUANT] Report carries ${mathHits.length} model-math claims with no computable model — running purge repair`, source: 'researchAgent', ts: Date.now() });
                const purgeR = await callChat([{ role: 'system', content: `You are a strict quantitative-claims editor. The research pipeline could NOT compute a quantitative finance model for this report (missing price/EPS/beta in the verified sources — a separate "Quantitative Model" section will explain why).\n\nREWRITE THE REPORT SO THAT:\n1. EVERY quantitative-finance claim is REMOVED — invented expected returns, Sharpe ratios, VaR figures, GBM/Ito derivations, drift corrections, volatility drags, DCF/intrinsic-value numbers, Monte Carlo, jump-diffusion, CAPM/cost-of-equity figures, implied volatility. These were fabricated.\n2. Where a paragraph depended on such math, replace the math sentence with: "A full quantitative model could not be computed from the verified sources; see the Quantitative Model section below."\n3. KEEP every other sentence, figure, citation tag ([Source N]), section heading, and the entire References section EXACTLY as-is.\n4. Do not add new analysis. Do not invent sources. Output ONLY the rewritten report — nothing else.` },
                    { role: 'user', content: `REPORT:\n${finalReport}` }], false, null, { ...opts, think: false, samplingProfile: 'reasoning' });
                const purged = (purgeR.content || '').trim();
                if (purged.length > finalReport.length * 0.5)
                    finalReport = purged;
                const remaining = MATH_TOKENS.filter((t) => t.test(finalReport));
                log({ level: remaining.length ? 'warn' : 'success', msg: `[QUANT] Purge repair ${remaining.length ? `incomplete — ${remaining.length} tokens remain` : 'clean'}`, source: 'researchAgent', ts: Date.now() });
            }
        }
        // humanize flag: rewrite until the detector says 0% AI-ness, fixing any
        // damage each rewrite causes, looping until clean.
        if (opts.humanize) {
            log({ level: 'info', msg: '[HUMANIZE] Running humanize loop on final report...', source: 'researchAgent', ts: Date.now() });
            const h = await humanizeText(callChat, finalReport, { ...opts, log });
            finalReport = h.text;
            stepSummary.humanize = { iterations: h.iterations, finalScore: h.finalScore, ok: h.ok, history: h.history };
            log({ level: 'success', msg: `[HUMANIZE] Done — ${h.iterations} iterations, detector score ${h.finalScore}`, source: 'researchAgent', ts: Date.now() });
        }
        // the computed quant section is appended AFTER the critique loop AND the
        // humanize loop so no critic/repair/humanizer pass can rewrite
        // code-computed math — it lands between the conclusion and references
        // as a modeling appendix. (run 10: the humanizer paraphrased the
        // section's inputs line into "volatility: 08, 24, 28, 29".)
        if (quantModel && quantModel.section) {
            // same dual-pattern search as the humanize split — the writer's
            // References header may or may not carry the --- separator, and a
            // section landing AFTER the references would read as an appendix
            // to the bibliography
            const refIdx = finalReport.search(/\n---\n## References|\n## References/i);
            if (refIdx > -1)
                finalReport = finalReport.slice(0, refIdx) + '\n\n' + quantModel.section + finalReport.slice(refIdx);
            else
                finalReport += '\n\n' + quantModel.section;
            stepSummary.quant.injected = true;
            log({ level: 'success', msg: '[QUANT] Injected computed quantitative model section', source: 'researchAgent', ts: Date.now() });
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
export { detectAnswerFormat, plannerAgent, crawlerAgent, verificationAgent, scoreCredibility, extractAndSummarize, extractWithFallback, applyMMR, factVerificationLoop, reportWriterAgent, buildAPACitation, buildCoverageGapsDisclaimer, detectResearchDomain, sourceFidelityVerifier, mathLogicVerifier, domainExpertCritic, adversarialCritic, constrainedRepairAgent, critiqueAndRepairLoop, quantConformanceRepair, isolatedCall, mergeDuplicateClaims, recoverStockQuote, DEFAULT_ACADEMIC_WHITELIST, DEFAULT_ACADEMIC_BLACKLIST, DEFAULT_NEGATIVE_URL_PATTERNS, };
