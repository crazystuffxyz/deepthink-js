// internet/extractCitation.ts
// fetch a URL, pull author/title/date, return 9 citation styles.
import axios from './axios.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'n.d.';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'n.d.';
  return d.toISOString().split('T')[0];
}

// Readability's byline is unreliable — on Wikipedia it sometimes grabs a
// section heading ("9.5 French Competition Authority investigation") as the
// author. sanitizeAuthor rejects anything that isn't plausibly a person or
// org name: section-numbered headings, "By " prefixes, junk, overlong strings.
function sanitizeAuthor(raw: string): string {
  const s = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^By\s+/i, '');
  if (!s || s.length > 80) return 'Unknown Author';
  if (/^\d+(\.\d+)*\s+[A-Z]/.test(s)) return 'Unknown Author'; // "9.5 French..." section heading
  if (/wikipedia|wikimedia/i.test(s)) return 'Unknown Author';
  if (/^(the|a|an)\s+(article|page|report|post)$/i.test(s)) return 'Unknown Author';
  if (/^[a-z0-9]{1,3}$/.test(s)) return 'Unknown Author'; // "by", "ed", "me"
  return s;
}

// login walls and bot-blockers serve junk <title> tags ("Create Account",
// "Just a moment...", "Access Denied") — run 15 shipped a reference titled
// "Create Account - FinanceCharts.com". reject those titles outright; the
// caller falls back to a URL-derived title.
function sanitizeTitle(raw: string): string {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 200) return 'Untitled';
  const junk = /^(create account|sign in|log in|login|register|access denied|forbidden|page not found|not found|just a moment|attention required|verify you are a human|sorry, you have been blocked|access to this page has been denied|subscribe|membership|unlock|enable javascript|checking your browser|one more step|under maintenance|site is down|error \d{3}|404|403|401|500|welcome|home|homepage|index)$/i;
  if (junk.test(s)) return 'Untitled';
  // "Create Account - FinanceCharts.com" — junk prefix before a separator
  const base = s.split(/\s*[|–—-]\s*/)[0].trim();
  if (junk.test(base)) return 'Untitled';
  return s;
}

function formatCitations(data: { author: string; title: string; year: number | string; site: string; url: string; accessed: string }): Record<string, string> {
  const { author, title, year, site, url, accessed } = data;
  const a = author === 'Unknown Author' ? '' : author;
  return {
    APA: `${a} (${year}). *${title}*. ${site}. ${url}`,
    MLA: `${a}. "${title}." *${site}*, ${year}, ${url}. Accessed ${accessed}.`,
    Chicago: `${a}. "${title}." *${site}*, ${year}. Accessed ${accessed}. ${url}.`,
    Harvard: `${a}, ${year}. *${title}*, ${site}. Available at: ${url} (Accessed: ${accessed}).`,
    Vancouver: `${a}. ${title} [Internet]. ${year} [cited ${accessed}]. Available from: ${url}`,
    IEEE: `${a}, "${title}," *${site}*, ${year}. [Online]. Available: ${url}. [Accessed: ${accessed}].`,
    Bluebook: `${a}, *${title}*, ${site} (${year}), available at ${url} (last visited ${accessed}).`,
    ACS: `${a}. ${title}. ${site} ${year}. ${url} (accessed ${accessed}).`,
    AMA: `${a}. ${title}. ${site}. Published ${year}. Accessed ${accessed}. ${url}`,
    Turabian: `${a}. "${title}." *${site}*, ${year}. Accessed ${accessed}. ${url}.`
  };
}

export async function generateCitation(url: string): Promise<{ error: string } | { citations: Record<string, string>; data: Record<string, unknown> }> {
  if (!url || typeof url !== 'string') {
    return { error: 'Invalid URL provided. URL must be a non-empty string.' };
  }
  try {
    new URL(url);
  } catch (e) {
    return { error: `Invalid URL format: ${url}. ${(e as Error).message}` };
  }
  try {
    const response = await axios.get(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9', 'dnt': '1', 'priority': 'u=0, i',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
        'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    const html = response.data as string;
    const $ = cheerio.load(html);
    $('script, style, iframe, aside, noscript, form, .ads, .advertisement, [aria-hidden="true"]').remove();
    $('img').each((_, img) => {
      const alt = $(img).attr('alt') || 'Image';
      $(img).replaceWith(`<p>[Image: ${alt}]</p>`);
    });
    const cleanedHtml = $.html();
    const dom = new JSDOM(cleanedHtml, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const $meta = cheerio.load(html);
    const author = article?.byline || $meta('meta[name="author"]').attr('content') || $meta('meta[property="article:author"]').attr('content') || $meta('[class*="author"], [id*="author"], [class*="byline"], [id*="byline"]').first().text().trim() || 'Unknown Author';
    const title = article?.title || $meta('meta[property="og:title"]').attr('content') || $meta('title').first().text().trim() || 'Untitled';
    const rawDate = $meta('meta[property="article:published_time"]').attr('content') || $meta('meta[name="date"]').attr('content') || $meta('time[datetime]').attr('datetime') || article?.publishedTime || null;
    const year = rawDate ? new Date(rawDate).getFullYear() : 'n.d.';
    const finalYear = isNaN(parseInt(year as string)) ? 'n.d.' : parseInt(year as string);
    const site = article?.siteName || $meta('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
    const accessed = formatDate(new Date());
    const data = {
      author: sanitizeAuthor(author),
      title: sanitizeTitle(title),
      year: finalYear,
      site: site.replace(/\s+/g, ' ').trim(),
      url,
      accessed,
      rawDate: rawDate || 'n.d.',
      excerpt: article?.excerpt || $meta('meta[name="description"]').attr('content') || '',
      content: article?.textContent || ''
    };
    const citations = formatCitations(data);
    return { citations, data };
  } catch (err) {
    return { error: `Failed to extract citation from ${url}: ${(err as Error).message}` };
  }
}
