// internet/mullvadLetaClient.ts
// SearXNG meta-search via public instance list.
import axios from './axios.js';
const headerconfig = {
    'accept': '*/*', 'accept-language': 'en-US,en;q=0.9', 'dnt': '1',
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
};
let instancesPromise = null;
async function getWorkingSearxngInstances() {
    if (instancesPromise)
        return instancesPromise;
    instancesPromise = (async () => {
        if (process.stdout?.write)
            process.stdout.write('[mullvad] Fetching SearXNG instance list from searx.space...\n');
        const t0 = Date.now();
        try {
            const { data } = await axios.get('https://searx.space/data/instances.json');
            const elapsed = Date.now() - t0;
            const workingUrls = Object.keys(data.instances).filter(url => {
                const instance = data.instances[url];
                if (url.includes('.onion'))
                    return false;
                // searx.space dropped the `generator` field (2026) — every instance
                // listed there is SearXNG by definition, so accept anything with a
                // searxng git_url or a version stamp
                const isSearxng = instance.generator === 'searxng'
                    || /searxng/i.test(instance.git_url || '')
                    || typeof instance.version === 'string';
                const isHttpOk = instance.http?.status_code === 200 && instance.http?.error === null;
                const isSearchWorking = (instance.timing?.search?.success_percentage ?? 0) > 0;
                return isSearxng && isHttpOk && isSearchWorking;
            });
            if (process.stdout?.write)
                process.stdout.write(`[mullvad] Instance list fetched in ${elapsed}ms — ${workingUrls.length} clearnet instances found\n`);
            return workingUrls;
        }
        catch (error) {
            if (process.stdout?.write)
                process.stdout.write(`[mullvad] Failed to fetch instance list: ${error.message} — using fallback list\n`);
            instancesPromise = null;
            // known-good public instances, tried in order if the list fetch fails
            return ['https://search.rhscz.eu', 'https://search.mdosch.de', 'https://searx.tiekoetter.com', 'https://search.bus-hit.me'];
        }
    })();
    return instancesPromise;
}
function cleanHtml(text) {
    if (!text)
        return '';
    return text.replace(/<\/?[^>]+(>|$)/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
async function fetchSearxngPage(query, pageNo, baseUrl, retries = 1) {
    const maxRetries = Math.min(retries, 3);
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const t0 = Date.now();
        try {
            if (process.stdout?.write)
                process.stdout.write(`[mullvad] POST ${baseUrl}/search  query="${query.slice(0, 50)}"  page=${pageNo}  attempt=${attempt}/${maxRetries + 1}\n`);
            const response = await axios.post(`${baseUrl}/search`, new URLSearchParams({
                'q': query, 'category_general': '1', 'pageno': String(pageNo), 'language': 'auto',
                'time_range': '', 'safesearch': '0', 'theme': 'simple'
            }), {
                headers: { ...headerconfig, 'origin': baseUrl, 'content-type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });
            const elapsed = Date.now() - t0;
            const html = response.data;
            const mappedResults = [];
            const articleRegex = /<article class="result[^"]*">([\s\S]*?)<\/article>/g;
            let m;
            while ((m = articleRegex.exec(html)) !== null) {
                const articleContent = m[1];
                const titleMatch = /<h3>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(articleContent);
                const snippetMatch = /<p class="content[^"]*">([\s\S]*?)<\/p>/i.exec(articleContent);
                if (titleMatch) {
                    const link = titleMatch[1];
                    const title = cleanHtml(titleMatch[2]);
                    const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : '';
                    let hostname = '';
                    try {
                        hostname = new URL(link).hostname;
                    }
                    catch { /* ignore */ }
                    mappedResults.push({ title, link, snippet, cite: hostname });
                }
            }
            const hasMore = (() => {
                const pagenoMatch = /name="pageno"[^>]*value="(\d+)"/.exec(html);
                if (pagenoMatch)
                    return parseInt(pagenoMatch[1], 10) > pageNo;
                return html.includes('Next page') || html.includes('next_page') || html.includes(`value="${pageNo + 1}"`);
            })();
            if (process.stdout?.write)
                process.stdout.write(`[mullvad] page=${pageNo} done in ${elapsed}ms — ${mappedResults.length} results, hasMore=${hasMore}\n`);
            return { results: mappedResults, hasMore, actualResultsOnPage: mappedResults.length };
        }
        catch (error) {
            const status = error.response?.status;
            // 429 = rate limited: retrying the SAME instance just burns time — fail
            // fast so the outer loop switches to the next instance
            if (status === 429 || attempt > maxRetries) {
                if (process.stdout?.write)
                    process.stdout.write(`[mullvad] ${status === 429 ? 'RATE LIMITED' : 'FAILED'} page=${pageNo} on ${baseUrl}: ${error.message.slice(0, 100)}\n`);
                return { results: [], hasMore: false, actualResultsOnPage: 0 };
            }
            const delay = 1000 * attempt;
            if (process.stdout?.write)
                process.stdout.write(`[mullvad] Retry page=${pageNo} in ${delay}ms (attempt ${attempt}): ${error.message.slice(0, 80)}\n`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return { results: [], hasMore: false, actualResultsOnPage: 0 };
}
export async function getMullvadLetaResults(query, desiredResultCount = 20, maxPagesToFetch = 5, perPageRetries = 1, engine = 'google') {
    if (!query || String(query).trim() === '')
        return [];
    const tTotal = Date.now();
    if (process.stdout?.write)
        process.stdout.write(`[mullvad] getMullvadLetaResults: query="${query.slice(0, 60)}" want=${desiredResultCount} maxPages=${maxPagesToFetch}\n`);
    const instances = await getWorkingSearxngInstances();
    if (instances.length === 0) {
        if (process.stdout?.write)
            process.stdout.write('[mullvad] No working SearXNG instances available.\n');
        return [];
    }
    const max = Math.min(8, instances.length);
    // normalize trailing slashes ONCE — searx.space URLs carry them, and the
    // tried-set must compare the same strings the shuffle holds. run 13: the
    // stripped baseUrl never matched the unstripped entries, so every attempt
    // re-picked the same first instance and hammered a rate-limited one 8x.
    const normalized = [...new Set(instances.map((u) => u.replace(/\/+$/, '')))];
    const shuffled = [...normalized].sort(() => Math.random() - 0.5);
    const triedUrls = new Set();
    let allResults = [];
    const seenLinks = new Set();
    for (let instanceIdx = 0; instanceIdx < max; instanceIdx++) {
        const baseUrl = shuffled.find(u => !triedUrls.has(u));
        if (!baseUrl)
            break;
        triedUrls.add(baseUrl);
        if (process.stdout?.write)
            process.stdout.write(`[mullvad] Selected instance: ${baseUrl} (attempt ${instanceIdx + 1}/${max})\n`);
        let currentPage = 1;
        let keepFetching = true;
        let pagesFetchedCount = 0;
        let gotResultsFromThisInstance = false;
        while (pagesFetchedCount < maxPagesToFetch && keepFetching && allResults.length < desiredResultCount) {
            const pageData = await fetchSearxngPage(query, currentPage, baseUrl, perPageRetries);
            pagesFetchedCount++;
            if (pageData.results.length > 0) {
                gotResultsFromThisInstance = true;
                for (const res of pageData.results) {
                    if (res.link && !seenLinks.has(res.link)) {
                        allResults.push(res);
                        seenLinks.add(res.link);
                        if (allResults.length >= desiredResultCount) {
                            keepFetching = false;
                            break;
                        }
                    }
                }
            }
            if (!pageData.hasMore || pageData.actualResultsOnPage === 0)
                keepFetching = false;
            if (keepFetching)
                currentPage++;
        }
        if (allResults.length >= desiredResultCount)
            break;
        if (!gotResultsFromThisInstance)
            continue;
        if (allResults.length > 0 && instanceIdx < max - 1)
            continue;
        break;
    }
    const finalSlice = allResults.slice(0, desiredResultCount);
    if (process.stdout?.write)
        process.stdout.write(`[mullvad] DONE query="${query.slice(0, 50)}" — ${finalSlice.length} results in ${Date.now() - tTotal}ms (tried ${triedUrls.size} instances)\n`);
    return finalSlice;
}
