// thinking/researchAgent.js
'use strict';

import { getSearchResults, getFetchResults } from '../internet/interactWithInternet.js';
import { generateCitation } from '../internet/extractCitation.js';
import { runCognitiveFlow } from './cognitive.js';

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

function isolatedCall(callChat, systemPrompt, userContent, opts = {}) {
  return callChat([{
    role: 'system',
    content: systemPrompt
  }, {
    role: 'user',
    content: userContent
  }], false, null, {
    ...opts,
    think: false,
    autoSystemPrompt: false
  });
}
async function detectAnswerFormat(callChat, topic, opts = {}) {
  const r = await callChat([{
    role: 'system',
    content: `You are a Strategic Answer-Format Analyst. Your goal is to decompose a research request into a formal target specification.

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

    CRITICAL: Respond with RAW JSON ONLY. Start with '{' and end with '}'.`,
  }, {
    role: 'user',
    content: `Research request: ${topic}`
  }], false, null, {
    ...opts,
    think: false,
    samplingProfile: 'json'
  });
  try {
    const raw = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(raw);
    console.log(`\x1b[36m[STEP 0] Answer format: type=${parsed.answerType} | fields=${(parsed.requiredFields || []).join(', ')}\x1b[0m`);
    return parsed;
  } catch {
    console.warn('\x1b[33m[STEP 0] Format detection parse failed — using passthrough spec\x1b[0m');
    return {
      answerType: 'analysis',
      requiredFields: ['relevant information', 'specific facts'],
      timeConstraints: [],
      entityTypes: [],
      queryHints: [topic],
      directAnswerTemplate: 'A direct answer to the question.'
    };
  }
}
async function plannerAgent(callChat, topic, answerSpec, opts = {}) {
  const maxQueries = opts.maxQueries ?? 12;
  const recursionDepth = opts.recursionDepth ?? 2;
  const d0count = maxQueries;
  const d1count = Math.floor(maxQueries / 2);
  const d2count = Math.floor(maxQueries / 4);
  const queryHintsBlock = (answerSpec.queryHints || []).length ? `\nPrioritize queries in this space:\n${answerSpec.queryHints.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}` : '';
  const entityNote = (answerSpec.entityTypes || []).length ? `\nEvery query should aim to surface: ${answerSpec.entityTypes.join(', ')}.` : '';
  const timeNote = (answerSpec.timeConstraints || []).length ? `\nTime constraints to honour: ${answerSpec.timeConstraints.join('; ')}.` : '';
  console.log(`\x1b[36m[STEP 1] Query DAG expansion for: "${topic.slice(0, 60)}..."\x1b[0m`);
  const r = await callChat([{
    role: 'system',
    content: `You are a Research Strategy Architect. Design a diverse search query portfolio to maximize "Information Gain" and eliminate blind spots.

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

    CRITICAL: Respond with RAW JSON ONLY. Start with '{' and end with '}'.`,
  }, {
    role: 'user',
    content: `Research topic: ${topic}`
  }], false, null, {
    ...opts,
    think: true,
    samplingProfile: 'planning'
  });
  try {
    const raw = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const plan = JSON.parse(raw);
    const queries = Array.isArray(plan.queries) ? plan.queries : [];
    const total = d0count + d1count + d2count;
    const sliced = queries.slice(0, total);
    console.log(`\x1b[36m[STEP 1] Generated ${sliced.length} queries across ${recursionDepth} DAG depths\x1b[0m`);
    return sliced;
  } catch {
    console.warn('\x1b[33m[STEP 1] JSON parse failed — using fallback queries\x1b[0m');
    return (answerSpec.queryHints || [topic]).map((q, i) => ({
      query: q,
      goal: 'Directly answer the user question',
      depth: i === 0 ? 0 : 1,
      topic: 'general'
    }));
  }
}
async function crawlerAgent(queries, maxConcurrency = 5, opts = {}) {
  const searchLabel = opts.useOllamaSearch ? 'Ollama API' : 'SearXNG';
  console.log(`\x1b[36m[STEP 2] Parallel crawl via ${searchLabel} — ${queries.length} queries, concurrency=${maxConcurrency}\x1b[0m`);
  const results = [];
  const seenUrls = new Set();
  for (let i = 0; i < queries.length; i += maxConcurrency) {
    const batch = queries.slice(i, i + maxConcurrency);
    const batchResults = await Promise.allSettled(batch.map(async ({
      query,
      goal,
      depth,
      topic
    }) => {
      const searchResults = await getSearchResults(query, opts);
      if (!Array.isArray(searchResults)) return [];
      return searchResults.map(r => ({
        url: r.link,
        title: r.title || '',
        snippet: r.snippet || '',
        cite: r.cite || '',
        query,
        goal,
        depth,
        topic: topic || 'general'
      }));
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
    console.log(`\x1b[36m[STEP 2] Batch ${Math.ceil((i + 1) / maxConcurrency)} complete — ${results.length} unique URLs so far\x1b[0m`);
  }
  return results;
}

function scoreCredibility(result, opts = {}) {
  let score = 40;
  const {
    url = '',
      snippet = '',
      title = ''
  } = result;
  try {
    const hostname = new URL(url).hostname;
    const tld2 = '.' + hostname.split('.').slice(-2).join('.');
    const tld1 = '.' + hostname.split('.').pop();
    if (HIGH_CREDIBILITY_TLDS.has(tld2)) score += 30;
    else if (HIGH_CREDIBILITY_TLDS.has(tld1)) score += 20;
  } catch {
    score -= 20;
  }
  const text = (snippet + ' ' + title).toLowerCase();
  const academicSignals = ['study', 'research', 'analysis', 'data', 'findings', 'published', 'journal', 'peer-reviewed', 'according to', 'evidence'];
  score += Math.min(academicSignals.filter(s => text.includes(s)).length * 3, 20);
  if (snippet.length > 200) score += 10;
  if (snippet.length < 30) score -= 15;
  for (const pattern of LOW_CREDIBILITY_SIGNALS) {
    if (pattern.test(url) || pattern.test(text)) {
      score -= 25;
      break;
    }
  }
  if (result.depth === 0) score += 5;
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
    if (p === '' || p === '/index.html' || p === '/index.php') score -= 20;
  } catch {}
  return Math.max(0, Math.min(100, score));
}

function verificationAgent(rawResults, threshold = 35, opts = {}) {
  let results = rawResults;
  if (opts.academicFilter) {
    const wlMode = opts.academicWhitelistMode || 'extend';
    let whitelist = wlMode === 'replace' && opts.academicWhitelist ? new Set(opts.academicWhitelist) : new Set([...DEFAULT_ACADEMIC_WHITELIST, ...(opts.academicWhitelist || [])]);
    const blMode = opts.academicBlacklistMode || 'extend';
    let blacklist = blMode === 'replace' && opts.academicBlacklist ? new Set(opts.academicBlacklist) : new Set([...DEFAULT_ACADEMIC_BLACKLIST, ...(opts.academicBlacklist || [])]);
    const academic = new Set(['.edu', '.gov', '.org', '.ac.uk', '.ac.au', '.ac.nz']);
    const before = results.length;
    results = results.filter(r => {
      let hostname = '';
      try {
        hostname = new URL(r.url || '').hostname;
      } catch {
        return false;
      }
      if (blacklist.has(hostname)) return false;
      if (whitelist.has(hostname)) return true;
      const parts = hostname.split('.');
      const tld2 = '.' + parts.slice(-2).join('.');
      const tld1 = '.' + parts[parts.length - 1];
      return academic.has(tld2) || academic.has(tld1);
    });
    console.log(`\x1b[36m[STEP 3] Academic filter: ${before} → ${results.length} URLs\x1b[0m`);
  }
  const scored = results.map(r => ({
    ...r,
    credibilityScore: scoreCredibility(r, opts)
  })).filter(r => r.credibilityScore >= threshold).sort((a, b) => b.credibilityScore - a.credibilityScore);
  console.log(`\x1b[36m[STEP 3] Credibility filter: ${results.length} → ${scored.length} URLs (threshold=${threshold})\x1b[0m`);
  return scored;
}
async function extractAndSummarize(callChat, source, topic, answerSpec, opts) {
  const {
    url,
    goal,
    query,
    credibilityScore
  } = source;
  let rawContent;
  try {
    rawContent = await getFetchResults(url);
    if (!rawContent || typeof rawContent !== 'string' || rawContent.startsWith('Error:')) {
      return {
        url,
        goal,
        summary: null,
        credibilityScore,
        error: rawContent || 'Fetch failed'
      };
    }
  } catch (e) {
    return {
      url,
      goal,
      summary: null,
      credibilityScore,
      error: e.message
    };
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
      
      const formatR = await callChat([{
        role: 'system',
        content: `You are a High-Density Semantic Extraction Engine. Your task is to synthesize evidence for a specific research goal.

        GOAL: Answer "${topic}"
        ${requiredFieldsNote}${timeNote}${entityNote}

        MANDATORY DATE PROTOCOL:
        1. Locate the definitive PUBLICATION DATE of the source.
        2. Output it on the VERY FIRST LINE: "PUBLICATION_DATE: YYYY-MM-DD" (or "unknown").
        3. Every quantitative claim or specific event must be tagged with its source year in parentheses, e.g., "Revenue grew by 12% (2022)".

        EXTRACTION GUIDELINES:
        - Precision First: Extract exact figures, proper names, symbols, and technical specifications.
        - Zero Loss: Do not paraphrase away technical precision. If the text says "approximately 4.231", do not write "about 4".
        - Relevance Filter: Extract ONLY content that directly supports the research goal.
        - Signal-to-Noise: If the page contains no relevant evidence, output exactly: NO_RELEVANT_CONTENT.

        OUTPUT FORMAT:
        Line 1: PUBLICATION_DATE: ...
        Remaining: 2-5 dense, factual paragraphs. Focus on evidence, not narrative.`,
      }, {
        role: 'user',
        content: `Cognitive Analysis Result:\n${flowResult}\n\nNow, output the formal extraction block starting with PUBLICATION_DATE:`
      }], false, null, {
        ...opts,
        think: false,
        samplingProfile: 'reasoning'
      });
      
      rawSummary = (formatR.content || '').trim();
  } else {
      const r = await callChat([{
        role: 'system',
        content: `You are a High-Density Semantic Extraction Engine. Your task is to synthesize evidence for a specific research goal.

        GOAL: Answer "${topic}"
        ${requiredFieldsNote}${timeNote}${entityNote}

        MANDATORY DATE PROTOCOL:
        1. Locate the definitive PUBLICATION DATE of the source.
        2. Output it on the VERY FIRST LINE: "PUBLICATION_DATE: YYYY-MM-DD" (or "unknown").
        3. Every quantitative claim or specific event must be tagged with its source year in parentheses, e.g., "Revenue grew by 12% (2022)".

        EXTRACTION GUIDELINES:
        - Precision First: Extract exact figures, proper names, symbols, and technical specifications.
        - Zero Loss: Do not paraphrase away technical precision. If the text says "approximately 4.231", do not write "about 4".
        - Relevance Filter: Extract ONLY content that directly supports the research goal.
        - Signal-to-Noise: If the page contains no relevant evidence, output exactly: NO_RELEVANT_CONTENT.

        OUTPUT FORMAT:
        Line 1: PUBLICATION_DATE: ...
        Remaining: 2-5 dense, factual paragraphs. Focus on evidence, not narrative.`,
      }, {
        role: 'user',
        content: `Research Goal: ${goal}\nSearch Query: ${query}\nSource URL: ${url}\n\n` + `Content:\n${rawContent}\n\nExtract content relevant to: "${topic}"`
      }], false, null, {
        ...opts,
        think: false,
        samplingProfile: 'reasoning'
      });
      rawSummary = (r.content || '').trim();
  }
  
  if (!rawSummary || rawSummary === 'NO_RELEVANT_CONTENT' || rawSummary.length < 50) {
    return {
      url,
      goal,
      summary: null,
      credibilityScore,
      error: 'No relevant content found'
    };
  }
  let publicationDate = 'unknown';
  let summary = rawSummary;
  const dateLine = rawSummary.split('\n')[0] || '';
  const dateMatch = dateLine.match(/^PUBLICATION_DATE:\s*(.+)$/i);
  if (dateMatch) {
    publicationDate = dateMatch[1].trim();
    summary = rawSummary.slice(dateLine.length).replace(/^\n+/, '').trim();
  }
  if (!summary || summary.length < 30) {
    return {
      url,
      goal,
      summary: null,
      credibilityScore,
      error: 'No summary content after date extraction'
    };
  }
  return {
    url,
    goal,
    query,
    summary,
    credibilityScore,
    publicationDate
  };
}
async function extractWithFallback(callChat, primarySources, fallbackPool, topic, answerSpec, opts) {
  const maxToFetch = opts.maxSummaries ?? 20;
  const batchSize = opts.extractBatchSize ?? 10;
  const primaryUrls = new Set(primarySources.map(s => s.url));
  const fallbackQueue = fallbackPool.filter(s => !primaryUrls.has(s.url));
  let fallbackIdx = 0;
  const results = [];
  const workQueue = [...primarySources.slice(0, maxToFetch)];
  console.log(`\x1b[36m[STEP 4] Fetching ${workQueue.length} sources (${fallbackQueue.length} in fallback pool)...\x1b[0m`);
  for (let i = 0; i < workQueue.length; i += batchSize) {
    const batch = workQueue.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(s => extractAndSummarize(callChat, s, topic, answerSpec, opts)));
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value?.summary && !outcome.value.error) {
        results.push(outcome.value);
      } else {
        while (fallbackIdx < fallbackQueue.length) {
          const fb = fallbackQueue[fallbackIdx++];
          try {
            const fbResult = await extractAndSummarize(callChat, fb, topic, answerSpec, opts);
            if (fbResult?.summary && !fbResult.error) {
              console.log(`\x1b[33m[STEP 4] Fallback used: ${fb.url.slice(0, 60)}\x1b[0m`);
              results.push(fbResult);
              break;
            }
          } catch {}
        }
      }
    }
  }
  console.log(`\x1b[36m[STEP 4] Raw extraction: ${results.length} valid summaries\x1b[0m`);
  if (results.length === 0) return [];
  if (results.length <= 5) return results;
  const summaryIndex = results.map((s, i) => `[${i}] URL: ${s.url}\nCredibility: ${s.credibilityScore}\nExcerpt: ${s.summary || ''}`).join('\n\n---\n\n');
  try {
    const rankR = await isolatedCall(callChat, `You are a Research Relevance Ranker.\n` + `Given a topic and source summaries, rank them by how directly they answer the topic.\n` + `Output ONLY valid JSON — no prose, no markdown fences: {"ranked": [0, 3, 1, ...]}\n` + `Include ALL indices in the output. Do not filter any out.`, `Topic: "${topic}"\n\nSummaries:\n${summaryIndex}`, {
      ...opts,
      samplingProfile: 'json'
    });
    const cleaned = (rankR.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const rankData = JSON.parse(cleaned);
    if (Array.isArray(rankData.ranked) && rankData.ranked.length === results.length) {
      const reranked = rankData.ranked.filter(idx => typeof idx === 'number' && idx >= 0 && idx < results.length).map(idx => results[idx]);
      console.log(`\x1b[36m[STEP 4] Meta-selection reranked ${reranked.length} summaries\x1b[0m`);
      return reranked;
    }
  } catch (e) {
    console.warn(`\x1b[33m[STEP 4] Meta-selection failed (${e.message}) — using credibility order\x1b[0m`);
  }
  return results;
}

function applyMMR(summaries, maxResults = 20, diversityLambda = 0.6) {
  if (summaries.length <= maxResults) return summaries;

  function tokenize(text) {
    return new Set((text || '').toLowerCase().match(/\b\w{4,}\b/g) || []);
  }

  function jaccardSim(a, b) {
    const sa = tokenize(a),
      sb = tokenize(b);
    const inter = [...sa].filter(x => sb.has(x)).length;
    const union = new Set([...sa, ...sb]).size;
    return union === 0 ? 0 : inter / union;
  }
  const selected = [],
    candidates = [...summaries];
  while (selected.length < maxResults && candidates.length > 0) {
    let bestIdx = 0,
      bestScore = -Infinity;
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
  console.log(`\x1b[36m[STEP 4] MMR diversity filter: ${summaries.length} → ${selected.length} summaries\x1b[0m`);
  return selected;
}
async function factVerificationLoop(callChat, validSummaries, topic, opts) {
  console.log(`\x1b[36m[STEP 5] FACT verification loop — ${validSummaries.length} summaries\x1b[0m`);
  const verifiedNodes = [];
  for (const source of validSummaries) {
    const pubDateNote = source.publicationDate && source.publicationDate !== 'unknown' ? `\nThis article was published on: ${source.publicationDate}. Any claim must include this date context.` : '\nPublication date is unknown for this source.';
    const claimsR = await callChat([{
      role: 'system',
      content: `Extract every distinct factual claim from this summary relevant to: "${topic}"\n` + `Output ONLY valid JSON — no markdown fences, no prose: {"claims": ["claim 1", "claim 2", ...]}\n` + `A claim is a specific, verifiable assertion with concrete data (numbers, names, dates, symbols).\n` + `IMPORTANT: Each claim must include the year/date of the data.\n` + `Do NOT omit or change the year to a different year.${pubDateNote}`
    }, {
      role: 'user',
      content: `Summary from ${source.url}:\n${source.summary || ''}`
    }], false, null, {
      ...opts,
      think: false,
      samplingProfile: 'json'
    });
    let claims = [];
    try {
      const cleaned = (claimsR.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      claims = JSON.parse(cleaned)?.claims ?? [];
    } catch {
      claims = [];
    }
    if (claims.length === 0) continue;
    let citationData = null;
    try {
      const citResult = await generateCitation(source.url);
      if (!citResult.error) citationData = citResult;
    } catch {}
    const max = 2;
    const verifiedClaims = [];
    for (const claim of claims) {
      let verifiedClaim = claim,
        verified = false;
      for (let loop = 0; loop < max; loop++) {
        const verifyR = await callChat([{
          role: 'system',
          content: `You are a Fact Verifier.\n` + `Source content:\n${source.summary || ''}\n\n` + `DATE RULES — CRITICAL:\n` + `  - The article was published on: ${source.publicationDate || 'unknown'}.\n` + `  - Do NOT change any year or date in the claim.\n` + `  - If the article is from 2023 or 2024, label it historical — NOT 2026.\n\n` + `Does the source content explicitly support the claim?\n` + `Output ONLY valid JSON — no markdown fences:\n` + `{"supported": true|false, "confidence": 0-100, "correction": "corrected claim or null"}`
        }, {
          role: 'user',
          content: `Claim: "${verifiedClaim}"\nSource: ${source.url}`
        }], false, null, {
          ...opts,
          think: false,
          samplingProfile: 'verify'
        });
        try {
          const cleaned = (verifyR.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
          const vResult = JSON.parse(cleaned);
          if (vResult.supported && vResult.confidence >= 60) {
            verified = true;
            break;
          } else if (vResult.correction && loop < max - 1) {
            console.warn(`\x1b[33m[STEP 5] Claim corrected: "${verifiedClaim.slice(0, 100)}..."\x1b[0m`);
            verifiedClaim = vResult.correction;
          } else {
            console.warn(`\x1b[33m[STEP 5] Claim discarded: "${verifiedClaim.slice(0, 100)}..."\x1b[0m`);
            break;
          }
        } catch {
          break;
        }
      }
      if (verified) verifiedClaims.push({
        claim: verifiedClaim,
        url: source.url,
        goal: source.goal,
        credibility: source.credibilityScore,
        publicationDate: source.publicationDate || 'unknown',
        citation: citationData,
        citedSummary: source.summary,
        verified: true
      });
    }
    verifiedNodes.push(...verifiedClaims);
    console.log(`\x1b[36m[STEP 5] ${source.url.slice(0, 50)}... → ${verifiedClaims.length}/${claims.length} claims verified\x1b[0m`);
  }
  console.log(`\x1b[32m[STEP 5] FACT complete — ${verifiedNodes.length} total verified claims\x1b[0m`);
  return verifiedNodes;
}

function buildAPACitation(ref) {
  const author = ref.author && ref.author !== 'Unknown Author' && ref.author.trim() ? ref.author.trim() : '';
  const year = ref.year || 'n.d.';
  const title = (ref.title || 'Untitled').trim();
  const site = (ref.site || (() => {
    try {
      return new URL(ref.url).hostname;
    } catch {
      return ref.url;
    }
  })()).trim();
  const url = ref.url;
  const authorPart = author ? `${author} ` : '';
  return `${authorPart}(${year}). *${title}*. ${site}. ${url}`;
}

function buildCoverageGapsDisclaimer(plannedQueries, verifiedNodes) {
  if (!Array.isArray(plannedQueries) || plannedQueries.length === 0) return null;
  const plannedTopics = [...new Set(plannedQueries.map(q => (q.topic || q.goal || q.query || '').slice(0, 60)).filter(Boolean))];
  if (plannedTopics.length === 0) return null;
  const coveredGoals = new Set(verifiedNodes.map(n => (n.goal || '').toLowerCase()));
  const missingTopics = plannedTopics.filter(pt => {
    const ptLower = pt.toLowerCase();
    return ![...coveredGoals].some(goal => goal.split(/\s+/).some(word => word.length > 4 && ptLower.includes(word)));
  });
  if (missingTopics.length === 0) return null;
  const ratio = Math.round(missingTopics.length / plannedTopics.length * 100);
  if (ratio < 20) return null;
  return `## Coverage Gaps\n\n` + `This report was planned to cover **${plannedTopics.length} topic areas**, ` + `but **${missingTopics.length} (${ratio}%)** returned no verified data, ` + `likely due to paywalls, bot-protection, or search engine rate-limiting.\n\n` + `**Topics with no recovered data:**\n` + missingTopics.slice(0, 15).map(t => `- ${t}`).join('\n') + (missingTopics.length > 15 ? `\n- *(and ${missingTopics.length - 15} more...)*` : '') + `\n\nFindings in this report are limited to sectors where data was successfully retrieved.\n\n---\n`;
}
async function reportWriterAgent(callChat, topic, answerSpec, verifiedNodes, opts, plannedQueries = []) {
  console.log(`\x1b[36m[STEP 6] Report Writer — ${verifiedNodes.length} verified claims, ${plannedQueries.length} planned queries\x1b[0m`);
  const chunk = opts.chunkSize ?? 20;
  const tail = opts.tailChars ?? 1500;
  const coverageGaps = buildCoverageGapsDisclaimer(plannedQueries, verifiedNodes);
  if (coverageGaps) console.warn(`\x1b[33m[STEP 6] Coverage gaps detected — disclaimer will be prepended\x1b[0m`);
  const refMap = new Map();
  for (const node of verifiedNodes) {
    if (!refMap.has(node.url)) {
      const cData = node.citation?.data || {};
      refMap.set(node.url, {
        id: refMap.size + 1,
        url: node.url,
        title: cData.title || node.citedSummary || 'Untitled',
        author: cData.author || '',
        year: cData.year || node.publicationDate || 'n.d.',
        site: cData.site || (() => {
          try {
            return new URL(node.url).hostname;
          } catch {
            return node.url;
          }
        })()
      });
    }
  }
  for (const [, ref] of refMap) ref.apa = buildAPACitation(ref);
  const chunks = [];
  for (let i = 0; i < verifiedNodes.length; i += chunk) chunks.push(verifiedNodes.slice(i, i + chunk));
  console.log(`\x1b[36m[STEP 6] Writing ${chunks.length} sections...\x1b[0m`);
  const sections = [];
  let previousTail = '';
  const requiredNote = (answerSpec.requiredFields || []).length ? `Required output fields: ${answerSpec.requiredFields.join(', ')}.` : '';
  const timeNote = (answerSpec.timeConstraints || []).length ? `Honour time constraints: ${answerSpec.timeConstraints.join('; ')}.` : '';
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkSlice = chunks[ci];
    const isFirst = ci === 0;
    const taggedClaims = chunkSlice.map(node => {
      const refId = refMap.get(node.url)?.id ?? '?';
      const pubTag = node.publicationDate && node.publicationDate !== 'unknown' ? ` [published ${node.publicationDate}]` : '';
      return `[Source ${refId}${pubTag}] ${node.claim}`;
    }).join('\n');
    const continuityNote = isFirst ? `Begin with a 3-sentence Executive Summary answering: "${topic}"` : `Continue the report seamlessly. The previous section ended with:\n"...${previousTail}"`;
    const r = await callChat([{
      role: 'system',
      content: `You are writing section ${ci + 1} of ${chunks.length} of a research report.\n\n` + `ORIGINAL QUESTION: "${topic}"\n${requiredNote}\n${timeNote}\n\n` + `SECTION RULES:\n` + `  1. Write complete, detailed prose for EVERY claim — do not skip any.\n` + `  2. Do NOT save tokens. Do NOT summarize. Write fully.\n` + `  3. Keep every [Source N] inline citation tag exactly as given.\n` + `  4. Use ## subheadings to group claims by theme.\n` + `  5. Do NOT write a conclusion — that comes in the final section.\n` + `  6. Do NOT write a references section.\n` + `  7. Do NOT repeat content from the previous section.\n` + `  8. Each [Source N] tag includes a published date. When citing historical data,\n` + `     clearly label it: "As of [date], ...". Do NOT present old data as current.\n\n` + `${continuityNote}`
    }, {
      role: 'user',
      content: `Claims for section ${ci + 1}:\n\n${taggedClaims}\n\nWrite the section now. Answer: "${topic}"`
    }], false, null, {
      ...opts,
      think: false,
      samplingProfile: 'creative'
    });
    const sectionText = (r.content || '').trim();
    sections.push(sectionText);
    previousTail = sectionText.slice(-tail);
    console.log(`\x1b[36m[STEP 6] Section ${ci + 1}/${chunks.length} written (${sectionText.length} chars)\x1b[0m`);
  }
  const concatenated = sections.join('\n\n');
  console.log(`\x1b[36m[STEP 6] Generating conclusion...\x1b[0m`);
  const conclusionR = await callChat([{
    role: 'system',
    content: `You are writing the CONCLUSION of a research report. One paragraph only.\n\n` + `ORIGINAL QUESTION: "${topic}"\n` + `ANSWER FORMAT: ${answerSpec.answerType}\n` + `ANSWER MUST CONTAIN: ${(answerSpec.requiredFields || []).join(', ')}\n` + `TEMPLATE: ${answerSpec.directAnswerTemplate || 'A direct, specific answer.'}\n\n` + `CONCLUSION RULES:\n` + `  - Directly answer the question — name names, symbols, dates.\n` + `  - Do NOT hedge with "it depends".\n` + `  - One paragraph, 5–8 sentences maximum.\n` + `  - Use [Source N] citations for key claims.\n` + `  - If citing historical data, explicitly state the data's year.\n` + `  - Do NOT write a references section.`
  }, {
    role: 'user',
    content: `Research report (final portion):\n${concatenated.slice(-4000)}\n\nWrite ONE conclusion paragraph that directly answers: "${topic}"`
  }], false, null, {
    ...opts,
    think: true,
    samplingProfile: 'reasoning'
  });
  const conclusion = (conclusionR.content || '').trim();
  const refsSection = '\n\n---\n## References\n\n' + [...refMap.values()].sort((a, b) => a.id - b.id).map(ref => `[${ref.id}] ${ref.apa}`).join('\n');
  const preamble = coverageGaps ? coverageGaps : '';
  const fullReport = preamble + concatenated + '\n\n---\n## Conclusion\n\n' + conclusion + refsSection;
  console.log(`\x1b[32m[STEP 6] Report done — ${fullReport.length} chars, ${refMap.size} sources\x1b[0m`);
  return {
    report: fullReport,
    references: [...refMap.values()],
    claimCount: verifiedNodes.length
  };
}
async function detectResearchDomain(callChat, topic, opts = {}) {
  console.log(`\x1b[36m[STEP 7] Domain detection for expert persona generation...\x1b[0m`);
  const r = await isolatedCall(callChat, `You are a Domain Classification System for academic research.\n` + `Given a research topic, identify the domain and generate an expert persona.\n\n` + `Output ONLY valid JSON — no markdown fences, no prose:\n` + `{\n` + `  "domain": "e.g. Mathematics",\n` + `  "subdomain": "e.g. Analytic Number Theory",\n` + `  "expertPersona": "Multi-sentence persona. Start: You are Professor [Name], a full professor of [subdomain] at [institution].",\n` + `  "keyRigorStandards": ["Standard 1", "Standard 2", "Standard 3"],\n` + `  "commonErrors": ["Error 1", "Error 2", "Error 3"]\n` + `}`, `Research topic: ${topic}`, {
    ...opts,
    samplingProfile: 'json'
  });
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const domain = JSON.parse(cleaned);
    console.log(`\x1b[36m[STEP 7] Domain: ${domain.domain} / ${domain.subdomain}\x1b[0m`);
    return domain;
  } catch {
    console.warn('\x1b[33m[STEP 7] Domain detection parse failed — using generic expert\x1b[0m');
    return {
      domain: 'General Research',
      subdomain: 'Academic Research',
      expertPersona: 'You are a senior research professor with 30 years of experience. ' + 'You apply rigorous standards and do not accept unsupported claims. ' + 'You check every assertion against cited evidence.',
      keyRigorStandards: ['Every claim must have a citation', 'Logical steps must be explicitly justified', 'Conclusions must follow from evidence presented'],
      commonErrors: ['Overgeneralization from limited data', 'Circular reasoning', 'Missing edge cases']
    };
  }
}
async function sourceFidelityVerifier(callChat, report, verifiedNodes, opts = {}) {
  console.log(`\x1b[35m[STEP 8A] Source Fidelity Verifier starting...\x1b[0m`);
  const evidenceIndex = verifiedNodes.slice(0, 30).map((node, i) => `SOURCE_EVIDENCE[${i + 1}]: "${node.citedSummary || node.claim || ''}"`).join('\n\n');
  const claimsList = verifiedNodes.slice(0, 30).map((node, i) => `CLAIM[${i + 1}]: ${node.claim} (citing source ${i + 1})`).join('\n');
  const r = await isolatedCall(callChat, `You are a Forensic Source Fidelity Auditor. Your mission is to detect "Evidence Drift"—where the report's claims subtly deviate from the source text.\n\n` + `AUDIT PROTOCOL:\n` + `  1. Map every claim to its specific source evidence.\n` + `  2. Check for "Overreach": Did the report infer something the source only hinted at?\n` + `  3. Check for "Precision Loss": Did the report round a number or simplify a technical term inaccurately?\n` + `  4. Check for "Date Misattribution": Is a 2022 fact being presented as a 2026 fact?\n\n` + `Output ONLY valid JSON — no markdown fences, no prose:\n` + `{"issues": [{"claimIndex": 1, "severity": "critical|major|minor", "type": "hallucinated|overreach|date_mismatch|number_mismatch|unsupported", "description": "...", "suggestion": "..."}], "totalChecked": 0, "fidelityScore": 0}\n` + `If zero issues are found, you must still justify why the fidelity is 100%.`, `CLAIMS TO CHECK:\n${claimsList}\n\nSOURCE EVIDENCE:\n${evidenceIndex}\n\nREPORT EXCERPT:\n${report}`, {
    ...opts,
    samplingProfile: 'verify'
  });
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(cleaned);
    console.log(`\x1b[35m[STEP 8A] Source Fidelity: ${result.issues?.length ?? 0} issues found, score=${result.fidelityScore ?? 'N/A'}\x1b[0m`);
    return {
      agent: 'sourceFidelity',
      ...result
    };
  } catch {
    console.warn('\x1b[33m[STEP 8A] Source fidelity parse failed\x1b[0m');
    return {
      agent: 'sourceFidelity',
      issues: [],
      totalChecked: 0,
      fidelityScore: 100
    };
  }
}
async function mathLogicVerifier(callChat, report, domain, opts = {}) {
  console.log(`\x1b[35m[STEP 8B] Math/Logic Verifier starting (domain: ${domain.subdomain})...\x1b[0m`);
  const r = await isolatedCall(callChat, `You are a Formal Mathematical and Logical Consistency Auditor specializing in ${domain.subdomain}.\n\n` + `Your goal is to find "hidden" contradictions or unjustified leaps in reasoning.\n\n` + `AUDIT PROCESS:\n` + `  1. Isolate every quantitative claim and the logic used to reach it.\n` + `  2. Re-derive the result from the reported ground truth using first principles.\n` + `  3. Check for "Tautological Reasoning": Are the conclusions merely repeating the premises?\n` + `  4. Verify all units, dimensions, and scales for consistency.\n\n` + `Output ONLY valid JSON — no markdown fences, no prose:\n` + `{"issues": [{"location": "exact text segment", "severity": "critical|major|minor", "type": "incorrect_equation|unjustified_step|missing_assumption|circular_reasoning|domain_error|other", "description": "...", "correction": "..."}], "hasMathContent": true, "mathRigorScore": 0}\n` + `If no math content is present, return {"issues": [], "hasMathContent": false, "mathRigorScore": 100}.`, `REPORT TO VERIFY:\n\n${report}`, {
    ...opts,
    samplingProfile: 'verify'
  });
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(cleaned);
    console.log(`\x1b[35m[STEP 8B] Math/Logic: ${result.issues?.length ?? 0} issues found, score=${result.mathRigorScore ?? 'N/A'}\x1b[0m`);
    return {
      agent: 'mathLogic',
      ...result
    };
  } catch {
    console.warn('\x1b[33m[STEP 8B] Math/Logic parse failed\x1b[0m');
    return {
      agent: 'mathLogic',
      issues: [],
      hasMathContent: false,
      mathRigorScore: 100
    };
  }
}
async function domainExpertCritic(callChat, report, domainInfo, opts = {}) {
  console.log(`\x1b[35m[STEP 8C] Domain Expert Critic starting (${domainInfo.domain})...\x1b[0m`);
  const rigorStandards = (domainInfo.keyRigorStandards || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n');
  const commonErrors = (domainInfo.commonErrors || []).map((e, i) => `  ${i + 1}. ${e}`).join('\n');
  const r = await isolatedCall(callChat, `${domainInfo.expertPersona}\n\n` + `You are conducting a rigorous formal peer review for a top-tier academic journal.\n\n` + `CRITIQUE LENS:\n` + `  - RIGOR: ${rigorStandards}\n` + `  - COMMON PITFALLS: ${commonErrors}\n\n` + `Your goal is to identify "Intellectual Gaps"—where the report simplifies a complex reality or ignores a key counter-perspective.\n\n` + `Output ONLY valid JSON — no markdown fences, no prose:\n` + `{"overallAssessment": "accept|major_revision|minor_revision|reject", "issues": [{"location": "...", "severity": "critical|major|minor", "type": "rigor|oversimplification|missing_caveat|scope_violation|terminology|overclaiming|other", "description": "...", "recommendation": "..."}], "strengths": ["..."], "missingTopics": ["..."]}`, `REPORT UNDER PEER REVIEW:\n\n${report}`, {
    ...opts,
    samplingProfile: 'verify'
  });
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(cleaned);
    console.log(`\x1b[35m[STEP 8C] Domain Expert: ${result.overallAssessment}, ${result.issues?.length ?? 0} issues found\x1b[0m`);
    return {
      agent: 'domainExpert',
      domainInfo,
      ...result
    };
  } catch {
    console.warn('\x1b[33m[STEP 8C] Domain expert parse failed\x1b[0m');
    return {
      agent: 'domainExpert',
      domainInfo,
      overallAssessment: 'minor_revision',
      issues: []
    };
  }
}
async function adversarialCritic(callChat, report, topic, opts = {}) {
  console.log(`\x1b[35m[STEP 8D] Adversarial Critic starting...\x1b[0m`);
  const r = await isolatedCall(callChat, `You are a professional Devil's Advocate and Red-Team Auditor. Your goal is not to 'review' the report, but to systematically dismantle it by identifying fragile claims, confirmation bias, and logical leaps.\n\n` + `ATTACK VECTORS:\n` + `  1. Fragile Claims: Identify assertions that rely on a single, potentially biased source or an outlier data point.\n` + `  2. Confirmation Bias: Detect where the report ignored contradictory evidence to fit a pre-determined narrative.\n` + `  3. Extrapolation Error: Flag instances where a narrow finding is presented as a broad trend.\n` + `  4. Semantic Slippage: Find where terms are used inconsistently to bridge a logical gap.\n\n` + `Output ONLY valid JSON — no markdown fences, no prose:\n` + `{"vulnerabilities": [{"claim": "exact quote", "attackVector": "...", "severity": "critical|major|minor", "counterEvidence": "...", "verdict": "likely_wrong|possibly_wrong|weak_support|acceptable"}], "weakestArgument": "...", "alternativeConclusion": "...", "overallVulnerabilityScore": 0}`, `REPORT TO ATTACK:\n\nTopic: ${topic}\n\n${report}`, {
    ...opts,
    samplingProfile: 'verify'
  });
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(cleaned);
    const critical = (result.vulnerabilities || []).filter(v => v.verdict === 'likely_wrong' || v.verdict === 'possibly_wrong').length;
    console.log(`\x1b[35m[STEP 8D] Adversarial: ${result.vulnerabilities?.length ?? 0} vulnerabilities, ${critical} critical, score=${result.overallVulnerabilityScore ?? 'N/A'}\x1b[0m`);
    return {
      agent: 'adversarial',
      ...result
    };
  } catch {
    console.warn('\x1b[33m[STEP 8D] Adversarial parse failed\x1b[0m');
    return {
      agent: 'adversarial',
      vulnerabilities: [],
      weakestArgument: '',
      alternativeConclusion: '',
      overallVulnerabilityScore: 0
    };
  }
}
async function constrainedRepairAgent(callChat, report, allIssues, topic, opts = {}) {
  if (allIssues.length === 0) {
    console.log(`\x1b[32m[STEP 9] No issues to repair — report accepted as-is\x1b[0m`);
    return report;
  }
  console.log(`\x1b[36m[STEP 9] Constrained Repair — fixing ${allIssues.length} flagged issues...\x1b[0m`);
  const issuesList = allIssues.map((issue, i) => {
    const lines = [`ISSUE ${i + 1} [${issue.severity?.toUpperCase() ?? 'UNKNOWN'}] from ${issue.agent}:`, `  Type: ${issue.type || 'general'}`, `  Problem: ${issue.description || issue.attackVector || 'See details'}`, `  Fix: ${issue.suggestion || issue.correction || issue.recommendation || 'Correct the issue as described'}`];
    if (issue.location || issue.claim) lines.push(`  Locator: "${issue.location || issue.claim || ''}"`);
    return lines.join('\n');
  }).join('\n\n');
  const r = await isolatedCall(callChat, `You are a Constrained Research Report Editor.\n\n` + `YOUR CONSTRAINTS:\n` + `  1. Fix ONLY the issues listed below. Do not change anything else.\n` + `  2. Do NOT rewrite sections that have no issues.\n` + `  3. Do NOT add new content beyond what is needed to fix the issues.\n` + `  4. Do NOT remove citations or references.\n` + `  5. Preserve all formatting, structure, and [Source N] citation tags.\n\n` + `Output the complete corrected report text ONLY — no preamble, no explanation.`, `RESEARCH TOPIC: ${topic}\n\nISSUES TO FIX:\n\n${issuesList}\n\n---\n\nORIGINAL REPORT:\n\n${report}`, {
    ...opts,
    think: true,
    samplingProfile: 'creative'
  });
  const repaired = (r.content || '').trim();
  if (repaired.length < report.length * 0.5) {
    console.warn('\x1b[33m[STEP 9] Repair produced suspiciously short output — keeping original\x1b[0m');
    return report;
  }
  console.log(`\x1b[32m[STEP 9] Repair complete — ${repaired.length} chars (original: ${report.length})\x1b[0m`);
  return repaired;
}
async function critiqueAndRepairLoop(callChat, report, verifiedNodes, topic, opts = {}) {
  const maxLoops = opts.maxCritiqueLoops ?? 2;
  const issueThreshold = opts.critiqueThreshold ?? 2;
  const severityWeights = {
    critical: 3,
    major: 2,
    minor: 1
  };
  const domainInfo = await detectResearchDomain(callChat, topic, opts);
  let currentReport = report;
  let critiqueHistory = [];
  for (let loop = 1; loop <= maxLoops; loop++) {
    console.log(`\x1b[36m[CRITIQUE LOOP ${loop}/${maxLoops}] Running all critics in parallel...\x1b[0m`);
    const [fidelityResult, mathResult, expertResult, adversarialResult] = await Promise.allSettled([sourceFidelityVerifier(callChat, currentReport, verifiedNodes, opts), mathLogicVerifier(callChat, currentReport, domainInfo, opts), domainExpertCritic(callChat, currentReport, domainInfo, opts), adversarialCritic(callChat, currentReport, topic, opts)]);
    const critics = [fidelityResult, mathResult, expertResult, adversarialResult].filter(r => r.status === 'fulfilled').map(r => r.value);
    const allIssues = [];
    for (const critic of critics) {
      for (const issue of critic.issues || []) {
        allIssues.push({
          ...issue,
          agent: critic.agent
        });
      }
      for (const vuln of critic.vulnerabilities || []) {
        if (vuln.verdict === 'likely_wrong' || vuln.verdict === 'possibly_wrong') {
          allIssues.push({
            agent: 'adversarial',
            severity: vuln.verdict === 'likely_wrong' ? 'major' : 'minor',
            type: 'adversarial_vulnerability',
            description: vuln.attackVector,
            suggestion: `Address this vulnerability: ${vuln.counterEvidence}`,
            location: vuln.claim
          });
        }
      }
    }
    const issueScore = allIssues.reduce((sum, issue) => sum + (severityWeights[issue.severity] || 1), 0);
    const criticalCount = allIssues.filter(i => i.severity === 'critical').length;
    console.log(`\x1b[36m[CRITIQUE LOOP ${loop}] Total issues: ${allIssues.length} | Weighted score: ${issueScore} | Critical: ${criticalCount}\x1b[0m`);
    const expertCritic = critics.find(c => c.agent === 'domainExpert');
    if (expertCritic?.overallAssessment) {
      console.log(`\x1b[35m[CRITIQUE LOOP ${loop}] Expert assessment: ${expertCritic.overallAssessment}\x1b[0m`);
    }
    critiqueHistory.push({
      loop,
      issueCount: allIssues.length,
      issueScore,
      criticalCount,
      expertAssessment: expertCritic?.overallAssessment
    });
    if (issueScore < issueThreshold && criticalCount === 0) {
      console.log(`\x1b[32m[CRITIQUE LOOP ${loop}] Issue score below threshold (${issueScore} < ${issueThreshold}) — report accepted\x1b[0m`);
      break;
    }
    allIssues.sort((a, b) => (severityWeights[b.severity] || 1) - (severityWeights[a.severity] || 1));
    currentReport = await constrainedRepairAgent(callChat, currentReport, allIssues, topic, opts);
    if (expertCritic?.overallAssessment === 'accept') {
      console.log(`\x1b[32m[CRITIQUE LOOP ${loop}] Expert accepts report — stopping critique loop\x1b[0m`);
      break;
    }
  }
  return {
    report: currentReport,
    critiqueHistory
  };
}
export default async function runDeepResearch(callChat, topic, opts = {}) {
  const stepSummary = {};
  if (opts.useOllamaSearch) console.log('\x1b[35m[CONFIG] Search backend: Ollama API\x1b[0m');
  else console.log('\x1b[35m[CONFIG] Search backend: SearXNG\x1b[0m');
  if (opts.academicFilter) console.log('\x1b[35m[CONFIG] Academic filter: ON\x1b[0m');
  if (opts.enableCritique !== false) console.log('\x1b[35m[CONFIG] Critique loop: ON\x1b[0m');
  try {
    const answerSpec = await detectAnswerFormat(callChat, topic, opts);
    stepSummary.step0 = {
      answerType: answerSpec.answerType,
      requiredFields: answerSpec.requiredFields
    };
    const queries = await plannerAgent(callChat, topic, answerSpec, opts);
    stepSummary.step1 = {
      queriesGenerated: queries.length
    };
    const rawResults = await crawlerAgent(queries, opts.maxConcurrency ?? 5, opts);
    stepSummary.step2 = {
      urlsRetrieved: rawResults.length
    };
    const verifiedSources = verificationAgent(rawResults, opts.credibilityThreshold ?? 35, opts);
    stepSummary.step3 = {
      urlsAfterFilter: verifiedSources.length
    };
    if (verifiedSources.length === 0) {
      return {
        report: `No credible sources found for: "${topic}". Try lowering credibilityThreshold or broadening queries.`,
        references: [],
        claimCount: 0,
        stepSummary,
        success: false
      };
    }
    const maxSourcesToFetch = opts.maxSummaries ?? 20;
    const primarySources = verifiedSources.slice(0, maxSourcesToFetch);
    const fallbackPool = verifiedSources.slice(maxSourcesToFetch);
    const rankedSummaries = await extractWithFallback(callChat, primarySources, fallbackPool, topic, answerSpec, opts);
    const diverseSummaries = applyMMR(rankedSummaries, opts.maxSummaries ?? 20, opts.diversityLambda ?? 0.6);
    stepSummary.step4 = {
      extracted: rankedSummaries.length,
      afterMMR: diverseSummaries.length,
      fallbackPoolSize: fallbackPool.length
    };
    if (diverseSummaries.length === 0) {
      return {
        report: `Content extraction failed for all sources on: "${topic}".`,
        references: [],
        claimCount: 0,
        stepSummary,
        success: false
      };
    }
    const verifiedNodes = await factVerificationLoop(callChat, diverseSummaries, topic, opts);
    stepSummary.step5 = {
      verifiedClaims: verifiedNodes.length
    };
    if (verifiedNodes.length === 0) {
      return {
        report: `All extracted claims failed factual verification for: "${topic}".`,
        references: [],
        claimCount: 0,
        stepSummary,
        success: false
      };
    }
    const {
      report: initialReport,
      references,
      claimCount
    } = await reportWriterAgent(callChat, topic, answerSpec, verifiedNodes, opts, queries);
    stepSummary.step6 = {
      reportLength: initialReport.length,
      uniqueSources: references.length
    };
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
        reportLengthDelta: finalReport.length - initialReport.length
      };
      console.log(`\x1b[32m[STEP 9] Critique loop complete — ${critiqueHistory.length} loops, final report: ${finalReport.length} chars\x1b[0m`);
    }
    console.log('\x1b[32m[DONE] Research complete. Final report delivered.\x1b[0m');
    return {
      report: finalReport,
      references,
      claimCount,
      stepSummary,
      critiqueHistory,
      success: true
    };
  } catch (e) {
    console.error(`\x1b[31m[researchAgent] Fatal error: ${e.message}\x1b[0m`);
    return {
      report: `Research failed: ${e.message}`,
      references: [],
      claimCount: 0,
      stepSummary,
      success: false
    };
  }
}
export { detectAnswerFormat, plannerAgent, crawlerAgent, verificationAgent, scoreCredibility, extractAndSummarize, extractWithFallback, applyMMR, factVerificationLoop, reportWriterAgent, buildAPACitation, buildCoverageGapsDisclaimer, detectResearchDomain, sourceFidelityVerifier, mathLogicVerifier, domainExpertCritic, adversarialCritic, constrainedRepairAgent, critiqueAndRepairLoop, isolatedCall, DEFAULT_ACADEMIC_WHITELIST, DEFAULT_ACADEMIC_BLACKLIST, DEFAULT_NEGATIVE_URL_PATTERNS };