// src/mcp-server/documents.js
// read-side parsers for the common document formats. used by deepthink_read_file
// when the path is a known document type, and by the parse_document tool.
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import Papa from 'papaparse';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import TurndownService from 'turndown';

// lazy so a missing pdf-parse doesn't crash the module
let pdfParse = null;
try {
  const mod = await import('pdf-parse');
  pdfParse = mod.default ?? mod;
} catch {
  pdfParse = null;
}

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

async function readPdf(filePath) {
  if (!pdfParse) return { ok: false, error: 'pdf-parse not installed' };
  try {
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return {
      ok: true,
      type: 'pdf',
      text: data.text,
      metadata: { pages: data.numpages, info: data.info || {} },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readDocx(filePath) {
  try {
    const { value, messages } = await mammoth.extractRawText({ path: filePath });
    return { ok: true, type: 'docx', text: value, warnings: messages || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readXlsx(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheets = {};
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      sheets[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    }
    // also build a flat markdown view (first 100 rows of first sheet) for quick reading
    let flat = '';
    if (wb.SheetNames.length > 0) {
      flat = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).slice(0, 20000);
    }
    return { ok: true, type: 'xlsx', sheets, sheetNames: wb.SheetNames, flat, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readCsv(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    return {
      ok: true,
      type: 'csv',
      rows: parsed.data,
      fields: parsed.meta.fields || [],
      errors: parsed.errors || [],
      rowCount: parsed.data.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readHtml(filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    const $ = cheerio.load(html);
    // strip script/style
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const title = $('title').text().trim();
    const headings = [];
    $('h1, h2, h3').each((_, el) => {
      headings.push({ level: el.tagName, text: $(el).text().trim() });
    });
    // also provide a markdown rendering for richer downstream consumption
    const markdown = td.turndown(html);
    return { ok: true, type: 'html', title, text, headings, markdown, length: text.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readMarkdown(filePath) {
  try {
    const md = fs.readFileSync(filePath, 'utf8');
    const html = marked.parse(md);
    const $ = cheerio.load(html);
    $('script, style').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return { ok: true, type: 'markdown', text, html, length: text.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, type: 'json', value: parsed, length: raw.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// dispatcher: pick the right reader based on extension
async function readAny(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const readers = {
    '.pdf': readPdf,
    '.docx': readDocx,
    '.xlsx': readXlsx,
    '.xls': readXlsx,
    '.csv': readCsv,
    '.html': readHtml,
    '.htm': readHtml,
    '.md': readMarkdown,
    '.markdown': readMarkdown,
    '.json': readJson,
  };
  const fn = readers[ext];
  if (fn) return fn(filePath);
  return { ok: false, error: `Unsupported file type: ${ext || '(none)'}` };
}

// single tool entry: parse any supported document at `path`
async function parseDocument(args) {
  const filePath = args.path;
  if (!filePath) return { ok: false, error: 'no path given' };
  if (!fs.existsSync(filePath)) return { ok: false, error: `file not found: ${filePath}` };
  return readAny(filePath);
}

export default {
  deepthink_parse_document: parseDocument,
};
