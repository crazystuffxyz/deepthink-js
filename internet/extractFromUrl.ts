// internet/extractFromUrl.ts
// fetch a URL, dispatch on MIME, return HTML article.
// @ts-nocheck — large pre-existing surface, runtime-tested, full type coverage deferred.
import axios from './axios.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import rtfToHtml from '@iarna/rtf-to-html';
import Papa from 'papaparse';
import path from 'node:path';

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapPre(text: string): string {
  return `<pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>`;
}

function mimeFromExtension(url: string): string | null {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.xml': 'application/xml', '.md': 'text/markdown', '.markdown': 'text/markdown',
    '.txt': 'text/plain', '.rtf': 'application/rtf', '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.epub': 'application/epub+zip',
    '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
  };
  return map[ext] || null;
}

function normaliseMime(contentType = ''): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

async function extractPdf(buffer: Buffer, url: string): Promise<string> {
  // pdf-parse v2: class-based API — new PDFParse({data}) → load() → getText()
  const parser = new PDFParse({ data: buffer });
  await parser.load();
  const data = await parser.getText() as { text: string; pages: Array<{ text: string; num: number }>; total: number };
  let info: any = {};
  try { info = await parser.getInfo(); } catch { /* info is optional */ }
  parser.destroy();
  const title = info?.info?.Title || info?.Title || '';
  const escaped = escapeHtml(data.text);
  const pages = escaped.split(/\f/).map((page, i) => `<section><h2>Page ${i + 1}</h2><p>${page.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p></section>`).join('\n');
  return `<article>\n        <h1>PDF Document${title ? ': ' + escapeHtml(title) : ''}</h1>\n        <p><em>${data.total} page(s) · ${data.text.length} chars extracted</em></p>\n        ${pages}\n    </article>`;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });
  if (result.messages.length) {
    if (process.stdout?.write) process.stdout.write(`[extractDocx] Mammoth warnings: ${JSON.stringify(result.messages)}\n`);
  }
  return `<article>${result.value}</article>`;
}

function extractSpreadsheet(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name];
    const html = XLSX.utils.sheet_to_html(sheet, { id: `sheet-${name}`, editable: false });
    return `<section><h2>Sheet: ${escapeHtml(name)}</h2>${html}</section>`;
  });
  return `<article>${parts.join('\n')}</article>`;
}

function extractCsv(text: string, delimiter = ','): string {
  const result = Papa.parse(text.trim(), { header: true, delimiter, skipEmptyLines: true }) as { data: Array<Record<string, string>>; meta: { fields?: string[] } };
  if (!result.data.length) return `<p>No data found in CSV.</p>`;
  const headers = result.meta.fields || Object.keys(result.data[0]);
  const headerRow = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const bodyRows = result.data.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h] ?? '')}</td>`).join('')}</tr>`).join('\n');
  return `<article>\n        <table border="1" cellpadding="4" cellspacing="0">\n            <thead><tr>${headerRow}</tr></thead>\n            <tbody>${bodyRows}</tbody>\n        </table>\n    </article>`;
}

async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => {
    const num = (s: string) => parseInt(s.match(/(\d+)\.xml$/)?.[1] || '0', 10);
    return num(a) - num(b);
  });
  const slides = await Promise.all(slideFiles.map(async (slideFile, i) => {
    const xml = await zip.files[slideFile].async('string');
    const parsed = parser.parse(xml);
    const texts: string[] = [];
    function collectText(obj: unknown): void {
      if (typeof obj === 'string') { texts.push(obj); return; }
      if (typeof obj !== 'object' || obj === null) return;
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'a:t') {
          if (typeof val === 'string') texts.push(val);
          else if (Array.isArray(val)) (val as unknown[]).forEach(v => typeof v === 'string' && texts.push(v));
        } else collectText(val);
      }
    }
    collectText(parsed);
    const content = texts.filter(Boolean).join(' ');
    return `<section><h2>Slide ${i + 1}</h2><p>${escapeHtml(content)}</p></section>`;
  }));
  return `<article>${slides.join('\n')}</article>`;
}

async function extractOdt(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const contentFile = zip.files['content.xml'];
  if (!contentFile) return '<p>No content.xml found in ODT file.</p>';
  const xml = await contentFile.async('string');
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const texts: string[] = [];
  function collect(obj: unknown): void {
    if (typeof obj === 'string') { texts.push(obj); return; }
    if (typeof obj !== 'object' || obj === null) return;
    for (const val of Object.values(obj)) collect(val);
  }
  collect(parsed);
  const paragraphs = texts.filter(Boolean).map(t => `<p>${escapeHtml(t)}</p>`).join('\n');
  return `<article>${paragraphs}</article>`;
}

async function extractEpub(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const containerXml = await zip.files['META-INF/container.xml']?.async('string');
  if (!containerXml) return '<p>Invalid EPUB: missing META-INF/container.xml.</p>';
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const container = parser.parse(containerXml);
  const opfPath = container?.container?.rootfiles?.rootfile?.['@_full-path'];
  if (!opfPath) return '<p>Could not locate OPF manifest in EPUB.</p>';
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfXml = await zip.files[opfPath]?.async('string');
  if (!opfXml) return '<p>OPF manifest file not found.</p>';
  const opf = parser.parse(opfXml);
  const manifest = opf?.package?.manifest?.item || [];
  const items = Array.isArray(manifest) ? manifest : [manifest];
  const spine = opf?.package?.spine?.itemref || [];
  const spineRefs = Array.isArray(spine) ? spine : [spine];
  const idToHref = Object.fromEntries(items.map((i: { '@_id': string; '@_href': string }) => [i['@_id'], i['@_href']]));
  const chapters = await Promise.all(spineRefs.map(async (ref: { '@_idref': string }) => {
    const href = idToHref[ref['@_idref']];
    if (!href) return '';
    const fullPath = opfDir + href;
    const html = (await zip.files[fullPath]?.async('string')) || '';
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return bodyMatch ? bodyMatch[1] : html;
  }));
  return `<article>${chapters.join('\n<hr>\n')}</article>`;
}

async function extractRtf(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    rtfToHtml.fromString(buffer.toString('utf8'), (err: Error | null, html: string) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}

function extractJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return `<article><pre style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre></article>`;
  } catch {
    return `<article>${wrapPre(text)}</article>`;
  }
}

function extractXml(text: string): string {
  return `<article><h2>XML Document</h2>${wrapPre(text)}</article>`;
}

function extractMarkdown(text: string): string {
  return `<article>${marked.parse(text)}</article>`;
}

function extractPlainText(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<article>${paragraphs}</article>`;
}

function extractImage(buffer: Buffer, mimeType: string, url: string): string {
  const b64 = buffer.toString('base64');
  return `<article>\n        <p><em>Image fetched from: ${escapeHtml(url)}</em></p>\n        <img src="data:${mimeType};base64,${b64}" alt="Fetched image" style="max-width:100%;">\n    </article>`;
}

function extractSvg(text: string): string {
  return `<article>${text}</article>`;
}

function extractUnknown(mimeType: string, url: string, byteLength: number): string {
  return `<article>\n        <p><strong>Unsupported or binary content</strong></p>\n        <ul>\n            <li>URL: ${escapeHtml(url)}</li>\n            <li>MIME type: ${escapeHtml(mimeType)}</li>\n            <li>Size: ${byteLength.toLocaleString()} bytes</li>\n        </ul>\n        <p>This content type cannot be rendered as text/HTML.</p>\n    </article>`;
}

function extractHtml(html: string, url: string): string {
  const $ = cheerio.load(html);
  $('script, style, link, iframe, aside, form, noscript, [aria-hidden="true"], .ads, .advertisement, embed, video, canvas').remove();
  $('img').each((_, img) => {
    const alt = $(img).attr('alt')?.trim() || 'No description';
    $(img).replaceWith(`<p>Image<br>Description: ${alt}<br>Link: ${$(img).attr('src')?.trim()}</p>`);
  });
  const cleanedHtml = $.html();
  const dom = new JSDOM(cleanedHtml, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (article?.content) return article.content;
  if (process.stdout?.write) process.stdout.write(`[extractHtml] Readability could not find main content on ${url}.\n`);
  return `Error: Could not extract readable content from ${url}. The page might not be an article or is structured in a way that Readability cannot process.`;
}

// local file variant: same extractors, but the bytes come from disk instead
// of the network. lets the research pipeline ingest user-supplied PDFs,
// docx, xlsx, pptx, csv, epub, rtf, odt, markdown, etc. as evidence sources.
export async function extractLocalFile(filePath: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const buffer = await fs.readFile(filePath);
  const mime = mimeFromExtension(filePath) || 'application/octet-stream';
  if (mime === 'application/pdf') return await extractPdf(buffer, filePath);
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/docx') return await extractDocx(buffer);
  if (mime === 'application/msword') {
    try { return await extractDocx(buffer); }
    catch { return `<article><p>Legacy .doc format could not be fully parsed. Please convert to .docx for best results.</p></article>`; }
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.template') return extractSpreadsheet(buffer);
  if (mime === 'application/vnd.oasis.opendocument.spreadsheet') return extractSpreadsheet(buffer);
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mime === 'application/vnd.ms-powerpoint') return await extractPptx(buffer);
  if (mime === 'application/vnd.oasis.opendocument.text') return await extractOdt(buffer);
  if (mime === 'application/epub+zip') return await extractEpub(buffer);
  if (mime === 'application/rtf' || mime === 'text/rtf') return await extractRtf(buffer);
  if (mime === 'text/csv' || mime === 'application/csv') return extractCsv(buffer.toString('utf8'), ',');
  if (mime === 'text/tab-separated-values') return extractCsv(buffer.toString('utf8'), '\t');
  if (mime === 'application/json' || mime === 'text/json') return extractJson(buffer.toString('utf8'));
  if (mime === 'application/xml' || mime === 'text/xml' || mime === 'application/rss+xml' || mime === 'application/atom+xml' || mime === 'application/soap+xml') return extractXml(buffer.toString('utf8'));
  if (mime === 'image/svg+xml') return extractSvg(buffer.toString('utf8'));
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return extractMarkdown(buffer.toString('utf8'));
  if (mime.startsWith('text/')) return extractPlainText(buffer.toString('utf8'));
  if (mime.startsWith('image/')) return extractImage(buffer, mime, filePath);
  return extractUnknown(mime, filePath, buffer.byteLength);
}

export async function extractArticleText(url: string): Promise<string> {
  try {
    if (process.stdout?.write) process.stdout.write(`[extractArticleText] Fetching URL: ${url}\n`);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'accept': '*/*', 'accept-language': 'en-US,en;q=0.9', 'dnt': '1',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
        'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    const buffer = Buffer.from(response.data as ArrayBuffer | string);
    const rawMime = normaliseMime(response.headers['content-type'] || '');
    const mime = (rawMime === 'application/octet-stream' || rawMime === 'binary/octet-stream' || !rawMime) ? (mimeFromExtension(url) || rawMime) : rawMime;
    if (process.stdout?.write) process.stdout.write(`[extractArticleText] Detected MIME type: ${mime}\n`);
    if (mime.includes('html')) return extractHtml(buffer.toString('utf8'), url);
    if (mime === 'application/pdf') return await extractPdf(buffer, url);
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/docx') return await extractDocx(buffer);
    if (mime === 'application/msword') {
      try { return await extractDocx(buffer); }
      catch { return `<article><p>Legacy .doc format could not be fully parsed. Please convert to .docx for best results.</p></article>`; }
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.template') return extractSpreadsheet(buffer);
    if (mime === 'application/vnd.oasis.opendocument.spreadsheet') return extractSpreadsheet(buffer);
    if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mime === 'application/vnd.ms-powerpoint') return await extractPptx(buffer);
    if (mime === 'application/vnd.oasis.opendocument.text') return await extractOdt(buffer);
    if (mime === 'application/epub+zip') return await extractEpub(buffer);
    if (mime === 'application/rtf' || mime === 'text/rtf') return await extractRtf(buffer);
    if (mime === 'text/csv' || mime === 'application/csv') return extractCsv(buffer.toString('utf8'), ',');
    if (mime === 'text/tab-separated-values') return extractCsv(buffer.toString('utf8'), '\t');
    if (mime === 'application/json' || mime === 'text/json') return extractJson(buffer.toString('utf8'));
    if (mime === 'application/xml' || mime === 'text/xml' || mime === 'application/rss+xml' || mime === 'application/atom+xml' || mime === 'application/soap+xml') return extractXml(buffer.toString('utf8'));
    if (mime === 'image/svg+xml') return extractSvg(buffer.toString('utf8'));
    if (mime === 'text/markdown' || mime === 'text/x-markdown') return extractMarkdown(buffer.toString('utf8'));
    if (mime.startsWith('text/')) return extractPlainText(buffer.toString('utf8'));
    if (mime.startsWith('image/')) return extractImage(buffer, mime, url);
    if (mime.startsWith('audio/') || mime.startsWith('video/')) return extractUnknown(mime, url, buffer.byteLength);
    if (mime === 'application/zip' || mime === 'application/x-zip-compressed') {
      const zip = await JSZip.loadAsync(buffer);
      const files = Object.keys(zip.files);
      const list = files.map(f => `<li>${escapeHtml(f)}</li>`).join('\n');
      return `<article><h2>ZIP Archive Contents</h2><ul>${list}</ul></article>`;
    }
    return extractUnknown(mime, url, buffer.byteLength);
  } catch (error: unknown) {
    let errorMessage = `Error processing URL ${url}: `;
    if (axios.isAxiosError(error)) {
      errorMessage += `Status ${(error as any).response?.status || 'N/A'} - ${(error as Error).message}`;
      if ((error as any).code === 'ECONNABORTED') errorMessage += ' (Timeout)';
      else if ((error as any).response?.status === 404) return `<p>Error: Content not found (404) at ${escapeHtml(url)}.</p>`;
      else if ((error as any).response?.status === 403) return `<p>Error: Access forbidden (403) at ${escapeHtml(url)}.</p>`;
    } else {
      errorMessage += (error as Error).message || 'Unknown error';
    }
    if (process.stdout?.write) process.stdout.write(`[extractArticleText] ${errorMessage}\n`);
    return `<p>Error: ${escapeHtml(errorMessage)}</p>`;
  }
}
