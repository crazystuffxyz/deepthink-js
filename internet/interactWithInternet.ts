// internet/interactWithInternet.ts
// @ts-nocheck — pre-existing surface, runtime-tested, type cleanup deferred.
import TurndownService from 'turndown';
import { extractArticleText } from './extractFromUrl.js';
import { getMullvadLetaResults } from './mullvadLetaClient.js';
import { getOllamaSearchResults } from './ollamaSearch.js';

const turndownService = new TurndownService({
  headingStyle: 'atx', hr: '---', bulletListMarker: '*', codeBlockStyle: 'fenced',
  emDelimiter: '_', strongDelimiter: '**', linkStyle: 'inlined', preformattedCode: true
});
turndownService.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content: string) => '~' + content + '~'
});
turndownService.addRule('images', {
  filter: 'img',
  replacement: (_content: string, node: any) => {
    const alt = node.getAttribute('alt') || '';
    const src = node.getAttribute('src') || '';
    const title = node.getAttribute('title') || '';
    if (!src) return '';
    return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
  }
});
turndownService.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);

type SearchResult = { link: string; title?: string; snippet?: string; cite?: string };

export async function getFetchResults(url: string): Promise<string> {
  try {
    const articleHtmlOrError = await extractArticleText(url);
    if (!articleHtmlOrError || typeof articleHtmlOrError !== 'string') {
      return `Error: Could not extract readable HTML content from ${url}.`;
    }
    if (articleHtmlOrError.startsWith('Error:')) return articleHtmlOrError;
    if (process.stdout?.write) process.stdout.write(turndownService.turndown(articleHtmlOrError).trim() + '\n');
    return turndownService.turndown(articleHtmlOrError).trim();
  } catch (error) {
    const msg = `[getFetchResults] Unexpected error processing URL ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    if (process.stdout?.write) process.stdout.write(msg + '\n' + (error instanceof Error ? error.stack : '') + '\n');
    return `Error: Failed to fetch or process content from ${url}. Details: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function getSearchResults(query: string, opts: { useOllamaSearch?: boolean; [k: string]: unknown } = {}): Promise<SearchResult[] | null> {
  const q = String(query ?? '').trim();
  if (opts.useOllamaSearch) {
    try {
      if (process.stdout?.write) process.stdout.write(`[getSearchResults] Routing to Ollama search for: "${q.slice(0, 60)}"\n`);
      const results = await getOllamaSearchResults(query, 5);
      if (results && results.length > 0) return results;
      if (process.stdout?.write) process.stdout.write('[getSearchResults] Ollama returned 0 results — falling back to SearXNG\n');
    } catch (err) {
      if (process.stdout?.write) process.stdout.write(`[getSearchResults] Ollama search failed: ${(err as Error).message} — falling back to SearXNG\n`);
    }
  }
  try {
    const results = await getMullvadLetaResults(q, 5, 1, 1, 'google');
    return results as unknown as SearchResult[];
  } catch (error) {
    if (process.stdout?.write) process.stdout.write(`[getSearchResults] SearXNG error for query "${q}": ${(error as Error)?.message ?? error}\n`);
    return null;
  }
}
