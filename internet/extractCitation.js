import axios from './axios.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';

function formatDate(date) {
  if (!date) return 'n.d.';
  const d = new Date(date);
  if (isNaN(d)) return 'n.d.';
  return d.toISOString().split('T')[0];
}

function formatCitations(data) {
  const {
    author,
    title,
    year,
    site,
    url,
    accessed
  } = data;
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
export async function generateCitation(url) {
  if (!url || typeof url !== 'string') {
    return {
      error: 'Invalid URL provided. URL must be a non-empty string.'
    };
  }
  try {
    new URL(url);
  } catch (e) {
    return {
      error: `Invalid URL format: ${url}. ${e.message}`
    };
  }
  try {
    const response = await axios.get(url, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        'dnt': '1',
        'priority': 'u=0, i',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    const html = response.data;
    const $ = cheerio.load(html);
    $('script, style, iframe, aside, noscript, form, .ads, .advertisement, [aria-hidden="true"]').remove();
    $('img').each((_, img) => {
      const alt = $(img).attr('alt') || 'Image';
      $(img).replaceWith(`<p>[Image: ${alt}]</p>`);
    });
    const cleanedHtml = $.html();
    const dom = new JSDOM(cleanedHtml, {
      url
    });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const $meta = cheerio.load(html);
    const author = article?.byline || $meta('meta[name="author"]').attr('content') || $meta('meta[property="article:author"]').attr('content') || $meta('[class*="author"], [id*="author"], [class*="byline"], [id*="byline"]').first().text().trim() || 'Unknown Author';
    const title = article?.title || $meta('meta[property="og:title"]').attr('content') || $meta('title').first().text().trim() || 'Untitled';
    const rawDate = $meta('meta[property="article:published_time"]').attr('content') || $meta('meta[name="date"]').attr('content') || $meta('time[datetime]').attr('datetime') || article?.publishedTime || null;
    const year = rawDate ? new Date(rawDate).getFullYear() : 'n.d.';
    const finalYear = isNaN(parseInt(year)) ? 'n.d.' : parseInt(year);
    const site = article?.siteName || $meta('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
    const accessed = formatDate(new Date());
    const data = {
      author: author.replace(/\s+/g, ' ').trim(),
      title: title.replace(/\s+/g, ' ').trim(),
      year: finalYear,
      site: site.replace(/\s+/g, ' ').trim(),
      url,
      accessed,
      rawDate: rawDate || 'n.d.',
      excerpt: article?.excerpt || $meta('meta[name="description"]').attr('content') || '',
      content: article?.textContent || ''
    };
    const citations = formatCitations(data);
    return {
      citations,
      data
    };
  } catch (err) {
    return {
      error: `Failed to extract citation from ${url}: ${err.message}`
    };
  }
}