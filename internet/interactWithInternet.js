import axios from './axios.js';
import TurndownService from 'turndown';
import { extractArticleText } from './extractFromUrl.js';
import { getMullvadLetaResults } from './mullvadLetaClient.js';
import { getOllamaSearchResults } from './ollamaSearch.js';
const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '*',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  preformattedCode: true
});
turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: content => '~' + content + '~'
});
turndownService.addRule('images', {
  filter: 'img',
  replacement: (content, node) => {
    const alt = node.getAttribute('alt') || '';
    const src = node.getAttribute('src') || '';
    const title = node.getAttribute('title') || '';
    if (!src) return '';
    return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
  }
});
turndownService.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);
async function getFetchResults(url) {
  try {
    const articleHtmlOrError = await extractArticleText(url);
    if (!articleHtmlOrError || typeof articleHtmlOrError !== 'string') {
      return `Error: Could not extract readable HTML content from ${url}.`;
    }
    if (articleHtmlOrError.startsWith('Error:')) {
      return articleHtmlOrError;
    }
    console.log(turndownService.turndown(articleHtmlOrError).trim());
    return turndownService.turndown(articleHtmlOrError).trim();
  } catch (error) {
    let msg = `[getFetchResults] Unexpected error processing URL ${url}: `;
    if (error instanceof Error) {
      msg += error.message;
      if (axios.isAxiosError(error)) {
        msg += ` (Axios Error - Status: ${error.response?.status ?? 'N/A'}`;
        if (error.code === 'ECONNABORTED') msg += ', Timeout';
        msg += ')';
      }
    } else {
      msg += 'An unknown error occurred.';
    }
    console.error(msg, error.stack);
    return `Error: Failed to fetch or process content from ${url}. Details: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}
async function getSearchResults(query, opts = {}) {
  if (opts.useOllamaSearch) {
    try {
      console.debug(`[getSearchResults] Routing to Ollama search for: "${query.slice(0, 60)}"`);
      const results = await getOllamaSearchResults(query, 5);
      if (results && results.length > 0) return results;
      console.warn('[getSearchResults] Ollama returned 0 results — falling back to SearXNG');
    } catch (err) {
      console.error(`[getSearchResults] Ollama search failed: ${err.message} — falling back to SearXNG`);
    }
  }
  try {
    const results = await getMullvadLetaResults(query, 5, 1, 1, 'google');
    return results;
  } catch (error) {
    let msg = `[getSearchResults] SearXNG error for query "${query}": `;
    msg += error instanceof Error ? error.message : 'Unknown error';
    console.error(msg, error.stack);
    return null;
  }
}
export { getFetchResults, getSearchResults };