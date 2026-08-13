// resolve any image source -> { base64, mimeType, source, bytes, width, height, raw }
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const CACHE_DIR = path.join(process.cwd(), 'data', 'img-cache');
const isFilePath = (s) => /[\\/]/.test(s) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(s);

export function sniffMime(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'; // PNG magic
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'; // JPEG magic
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'; // GIF magic
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'; // RIFF....WEBP
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'; // BMP magic
  // text sniff for svg / xml
  const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function extForMime(mime) {
  return (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/svg+xml': 'svg',
    }[mime] || 'bin'
  );
}

async function ensureCacheDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

// 5 redirect cap
function fetchUrlWithRedirects(url, { timeoutMs = 30_000 } = {}) {
  const go = (u, depth) =>
    new Promise((resolve, reject) => {
      if (depth > 5) return reject(new Error('too many redirects'));
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(go(res.headers.location, depth + 1));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`http ${res.statusCode} fetching ${u}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${u}`)));
    });
  return go(url, 0);
}

// best-effort; throws if no image
async function readClipboardImage() {
  // sharp cant read clipboard directly; use platform-specific shim
  const pExec = promisify(execFile);
  const tmp = path.join(CACHE_DIR, `clip-${Date.now()}.png`);
  await ensureCacheDir();
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
      if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 2 }
      $img = [System.Windows.Forms.Clipboard]::GetImage();
      $img.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
      exit 0`;
    await pExec('powershell', ['-NoProfile', '-Command', ps]);
    return fsp.readFile(tmp);
  }
  if (process.platform === 'darwin') {
    await pExec('osascript', [
      '-e',
      `set pngData to the clipboard as «class PNGf»\nset outFile to open for access POSIX file "${tmp}" with write permission\nwrite pngData to outFile\nclose access outFile`,
    ]);
    return fsp.readFile(tmp);
  }
  // linux: try xclip then wl-paste
  try {
    await pExec('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).then((r) => fsp.writeFile(tmp, r.stdout));
    return fsp.readFile(tmp);
  } catch {
    await pExec('wl-paste', ['-t', 'image/png'], { stdio: ['ignore', 'pipe', 'ignore'] }).then((r) =>
      fsp.writeFile(tmp, r.stdout),
    );
    return fsp.readFile(tmp);
  }
}

export class ImageUtils {
  static normalize(input) {
    if (input == null) return { type: 'base64', payload: '' };
    if (Buffer.isBuffer(input)) return { type: 'buffer', payload: input };
    if (typeof input === 'string') {
      // data:[<mime>];base64,<data>
      if (input.startsWith('data:')) {
        const m = input.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (m) return { type: 'base64', payload: m[3], mime: m[1] || '' };
      }
      if (/^https?:\/\//i.test(input)) return { type: 'url', payload: input };
      if (isFilePath(input)) return { type: 'file', payload: input };
      return { type: 'base64', payload: input };
    }
    if (typeof input === 'object') {
      if (input.type === 'base64' || input.base64) {
        return { type: 'base64', payload: input.data || input.base64, mime: input.mime || '' };
      }
      if (input.type === 'file' || input.path) return { type: 'file', payload: input.path };
      if (input.type === 'url' || input.url) return { type: 'url', payload: input.url };
      if (input.type === 'clipboard') return { type: 'clipboard', payload: null };
    }
    return { type: 'base64', payload: '' };
  }

  static async resolve(input, opts = {}) {
    const norm = ImageUtils.normalize(input);
    let buf;
    let source = norm.type;
    const hint = norm.mime || '';

    if (norm.type === 'base64') {
      if (!norm.payload) throw new Error('image-utils: empty base64 payload');
      buf = Buffer.from(norm.payload, 'base64');
    } else if (norm.type === 'buffer') {
      if (!norm.payload || !norm.payload.length) throw new Error('image-utils: empty buffer payload');
      buf = norm.payload;
      source = 'buffer';
    } else if (norm.type === 'file') {
      buf = await fsp.readFile(norm.payload);
      source = `file:${norm.payload}`;
    } else if (norm.type === 'url') {
      await ensureCacheDir();
      // url hash cache; skip on force
      const hash = crypto.createHash('sha1').update(norm.payload).digest('hex').slice(0, 16);
      const cached = path.join(CACHE_DIR, `${hash}.bin`);
      if (fs.existsSync(cached) && !opts.force) {
        buf = await fsp.readFile(cached);
      } else {
        buf = await fetchUrlWithRedirects(norm.payload, { timeoutMs: opts.timeoutMs || 30_000 });
        await fsp.writeFile(cached, buf);
      }
      source = `url:${norm.payload}`;
    } else if (norm.type === 'clipboard') {
      await ensureCacheDir();
      buf = await readClipboardImage();
      source = 'clipboard';
    } else {
      throw new Error(`image-utils: cannot resolve source "${norm.type}"`);
    }

    if (!buf || buf.length === 0) throw new Error('image-utils: empty buffer after resolve');

    const mime = hint || sniffMime(buf);
    let width = 0;
    let height = 0;
    try {
      // sharp can read png/jpeg/gif/webp/bmp/tiff; for svg metadata may miss
      const meta = await sharp(buf).metadata();
      width = meta.width || 0;
      height = meta.height || 0;
    } catch {
      // not an image sharp understands (raw svg is fine but metadata may miss)
    }

    return { base64: buf.toString('base64'), mimeType: mime, source, bytes: buf.length, width, height, raw: buf };
  }

  // normalize to png
  static async toPngBase64(input) {
    const r = await ImageUtils.resolve(input);
    if (r.mimeType === 'image/png') return r;
    const out = await sharp(r.raw).png().toBuffer();
    return {
      base64: out.toString('base64'),
      mimeType: 'image/png',
      source: r.source,
      bytes: out.length,
      width: r.width,
      height: r.height,
      raw: out,
    };
  }

  static async saveToFile(input, filePath) {
    const r = await ImageUtils.resolve(input);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, r.raw);
    return { ok: true, path: filePath, bytes: r.bytes };
  }

  static async fetchToFile(source, dir = CACHE_DIR) {
    await ensureCacheDir();
    const r = await ImageUtils.resolve(source);
    const ext = extForMime(r.mimeType);
    const name = `${crypto.createHash('sha1').update(r.base64).digest('hex').slice(0, 16)}.${ext}`;
    const fp = path.join(dir, name);
    await fsp.writeFile(fp, r.raw);
    return { path: fp, mime: r.mimeType, bytes: r.bytes, width: r.width, height: r.height };
  }
}

export class SvgRenderer {
  static looksLikeSvg(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim().toLowerCase();
    return t.startsWith('<svg') || t.startsWith('<?xml');
  }

  // pull a viewBox / width / height hint from the svg if present
  static dims(svg, fallbackW = 800, fallbackH = 600) {
    if (!svg) return { width: fallbackW, height: fallbackH };
    const wb = /viewBox\s*=\s*"([^"]+)"/i.exec(svg);
    if (wb) {
      const parts = wb[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (parts.length === 4) return { width: parts[2], height: parts[3] };
    }
    const wm = /<svg[^>]*\swidth\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(svg);
    const hm = /<svg[^>]*\sheight\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(svg);
    return {
      width: wm ? Number(wm[1]) : fallbackW,
      height: hm ? Number(hm[1]) : fallbackH,
    };
  }

  // wrap a bare fragment in <svg> root
  static wrap(svg, w = 800, h = 600) {
    if (!svg) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
    }
    const t = svg.trim();
    if (t.toLowerCase().startsWith('<svg')) return t;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${t}</svg>`;
  }

  static async toPng(svg, { width, height, density = 96, background = '#ffffff' } = {}) {
    if (!SvgRenderer.looksLikeSvg(svg)) {
      throw new Error('svg-renderer: input is not an svg');
    }
    const d = SvgRenderer.dims(svg, width || 800, height || 600);
    const wrapped = SvgRenderer.wrap(svg, d.width, d.height);
    // density helps w/ text antialiasing; background gives clean look
    return sharp(Buffer.from(wrapped), { density })
      .resize({ width: width || d.width, height: height || d.height, fit: 'inside' })
      .flatten({ background })
      .png()
      .toBuffer();
  }

  static async toPngBase64(svg, opts = {}) {
    const buf = await SvgRenderer.toPng(svg, opts);
    return { base64: buf.toString('base64'), bytes: buf.length, mimeType: 'image/png' };
  }

  static async toFile(svg, filePath, opts = {}) {
    const buf = await SvgRenderer.toPng(svg, opts);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buf);
    return { ok: true, path: filePath, bytes: buf.length };
  }

  // raster -> svg roundtrip sanity check
  static async validate(svg) {
    try {
      const buf = await SvgRenderer.toPng(svg, { width: 64, height: 64 });
      return { ok: buf.length > 0, bytes: buf.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
