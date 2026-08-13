// src/mcp-server/runner.js
// fs/shell/desktop/web primitives the agent can call.
// every file-mutating op records into ctx.tx so rollback can undo it.
import { exec } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// track temp files written by node/python run so they're not left in tx
function dropTx(ctx, filePath) {
  ctx.tx.ops = ctx.tx.ops.filter((t) => !(t.kind === 'write' && t.path === filePath));
}

// shell primitives
async function deepthink_shell(args, ctx) {
  const { command, cwd, timeout = 30000 } = args;
  if (!command || typeof command !== 'string') {
    return { ok: false, error: 'shell: "command" is required' };
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || os.homedir(),
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

async function deepthink_powershell(args, ctx) {
  const { command, cwd, timeout = 30000 } = args;
  if (!command || typeof command !== 'string') {
    return { ok: false, error: 'powershell: "command" is required' };
  }
  const isWin = process.platform === 'win32';
  if (isWin) {
    // -EncodedCommand = base64 UTF-16LE, immune to quote/escape hell —
    // command survives verbatim, no shell re-parsing.
    const b64 = Buffer.from(command, 'utf16le').toString('base64');
    return deepthink_shell({ command: `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, cwd, timeout }, ctx);
  }
  return deepthink_shell({ command: `bash -c "${command.replace(/"/g, '\\"')}"`, cwd, timeout }, ctx);
}

// js_execute runs user code in a pooled worker subprocess so it
// can't poison server state. workers stay warm between calls.
async function deepthink_js_execute(args, ctx) {
  const { code, timeout = 15000 } = args;
  if (typeof code !== 'string') {
    return { ok: false, error: 'js_execute: "code" is required' };
  }
  try {
    const r = await ctx.pool.eval(code, {}, { timeout });
    if (r.ok) return { ok: true, result: r.result, output: r.output };
    return { ok: false, error: r.error, stack: r.stack };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deepthink_cancel(_args, ctx) {
  ctx.cancel.set();
  return { ok: true, cancelled: true };
}

async function deepthink_read_file(args) {
  const { path: filePath, encoding = 'utf8' } = args;
  if (!filePath) return { ok: false, error: 'read_file: "path" is required' };
  try {
    const content = fs.readFileSync(filePath, encoding);
    return { ok: true, content, size: Buffer.byteLength(content, encoding) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_write_file(args, ctx) {
  const { path: filePath, content = '', encoding = 'utf8', append = false } = args;
  if (!filePath) return { ok: false, error: 'write_file: "path" is required' };
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      ctx.tx.record({ kind: 'mkdir', path: dir });
      fs.mkdirSync(dir, { recursive: true });
    }
    let prev;
    try {
      prev = fs.readFileSync(filePath, 'utf8');
    } catch {
      prev = null;
    }
    ctx.tx.record({ kind: 'write', path: filePath, prev });
    if (append) {
      fs.appendFileSync(filePath, content, encoding);
    } else {
      fs.writeFileSync(filePath, content, encoding);
    }
    return { ok: true, path: filePath, bytes: Buffer.byteLength(content, encoding) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_list_dir(args) {
  const { path: dirPath = '.', recursive = false } = args;
  try {
    const result = [];
    const walk = (dir, depth) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        result.push({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: full,
          depth,
        });
        // cap depth so a deep tree can't hang the loop
        if (recursive && e.isDirectory() && depth < 32) {
          try {
            walk(full, depth + 1);
          } catch {
            // unreadable subdir — skip
          }
        }
      }
    };
    walk(dirPath, 0);
    return { ok: true, entries: result, count: result.length, recursive: !!recursive };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_create_dir(args, ctx) {
  const { path: dirPath } = args;
  if (!dirPath) return { ok: false, error: 'create_dir: "path" is required' };
  try {
    ctx.tx.record({ kind: 'mkdir', path: dirPath });
    fs.mkdirSync(dirPath, { recursive: true });
    return { ok: true, path: dirPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_delete_file(args, ctx) {
  const { path: filePath } = args;
  if (!filePath) return { ok: false, error: 'delete_file: "path" is required' };
  try {
    let prev;
    try {
      prev = fs.readFileSync(filePath, 'utf8');
    } catch {
      prev = null;
    }
    ctx.tx.record({ kind: 'delete', path: filePath, prev });
    fs.unlinkSync(filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_copy_file(args, ctx) {
  const { src, dest } = args;
  if (!src || !dest) return { ok: false, error: 'copy_file: "src" and "dest" are required' };
  try {
    let prev;
    try {
      prev = fs.readFileSync(dest, 'utf8');
    } catch {
      prev = null;
    }
    ctx.tx.record({ kind: 'write', path: dest, prev });
    fs.copyFileSync(src, dest);
    return { ok: true, src, dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_rollback(_args, ctx) {
  const undone = await ctx.tx.rollback();
  return { ok: true, undone: undone.length };
}

// hostname-aware credibility score for web_search ranking.
// matches host labels so wikipedia.org.evil.com doesn't score high.
function scoreUrl(url) {
  let score = 50;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return score;
  }
  const hostMatches = (d) => {
    // bare tld-ish suffixes like .gov / .edu
    if (d.startsWith('.')) return host.endsWith(d) || host.includes(d + '.');
    return host === d || host.endsWith('.' + d);
  };
  const good = [
    'wikipedia.org',
    'github.com',
    '.gov',
    '.edu',
    'arxiv.org',
    'developer.mozilla.org',
    'w3.org',
    'stackoverflow.com',
    'mozilla.org',
    'ietf.org',
    'w3schools.com',
    'npmjs.com',
  ];
  for (const d of good) if (hostMatches(d)) score += 20;
  const bad = [
    'fiverr.com',
    'pinterest.com',
    'quora.com',
    'instagram.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'tiktok.com',
  ];
  for (const d of bad) if (hostMatches(d)) score -= 25;
  // spam hints check the full url — host spoofing can't hide these
  const lower = url.toLowerCase();
  for (const d of ['clickbait', 'coupon', 'deals', 'spam']) {
    if (lower.includes(d)) score -= 25;
  }
  return score;
}

// fetch a url, follow redirects (max 5), decompress gzip/brotli/deflate
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return fetchUrl(next, redirects + 1).then(resolve, reject);
        }
        // collect raw bytes, decompress by Content-Encoding — many
        // sites serve gzip/brotli; the old utf8 path garbled them
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          let out = buf;
          try {
            if (enc.includes('gzip')) out = zlib.gunzipSync(buf);
            else if (enc.includes('br')) out = zlib.brotliDecompressSync(buf);
            else if (enc.includes('deflate')) out = zlib.inflateSync(buf);
          } catch {
            // fall through with the raw buffer — better than failing
          }
          resolve(out.toString('utf8'));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function deepthink_web_search(args) {
  const { query, maxResults = 8 } = args;
  if (!query) return { ok: false, error: 'web_search: "query" is required' };
  try {
    const encoded = encodeURIComponent(query);
    const html = await fetchUrl(`https://html.duckduckgo.com/html/?q=${encoded}`);

    const urlRegex = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const results = [];
    const urls = [];
    let m;
    while ((m = urlRegex.exec(html)) && urls.length < maxResults * 2) {
      const raw = m[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*/, '');
      const url = decodeURIComponent(raw);
      const title = m[2].replace(/<[^>]*>/g, '').trim();
      if (url.startsWith('http')) urls.push({ url, title });
    }
    const snippets = [];
    while ((m = snippetRegex.exec(html))) snippets.push(m[1].replace(/<[^>]*>/g, '').trim());
    urls.forEach((u, i) => results.push({ ...u, snippet: snippets[i] || '', rating: scoreUrl(u.url) }));
    results.sort((a, b) => b.rating - a.rating);
    return { ok: true, results: results.slice(0, maxResults), query };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_web_fetch(args) {
  const { url, maxLength = 10000 } = args;
  if (!url) return { ok: false, error: 'web_fetch: "url" is required' };
  try {
    const html = await fetchUrl(url);
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > maxLength) text = text.slice(0, maxLength) + '... [truncated]';
    return { ok: true, content: text, url, length: text.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_open_url(args, ctx) {
  const { url } = args;
  if (!url) return { ok: false, error: 'open_url: "url" is required' };
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_http_request(args) {
  const { url, method = 'GET', headers = {}, body, timeout = 10000 } = args;
  if (!url) return { ok: false, error: 'http_request: "url" is required' };
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, error: `Invalid URL: ${url}` });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': 'deepthink/3.0', ...headers },
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ ok: true, status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function deepthink_screenshot(args, ctx) {
  const { save = false } = args;
  const file = path.join(os.tmpdir(), `deepthink_screenshot_${Date.now()}.png`);
  const cmd = process.platform === 'darwin' ? `screencapture -x ${file}` : `scrot ${file}`;
  const result = await deepthink_shell({ command: cmd }, ctx);
  if (result.ok && save) {
    return { ok: true, message: `Screenshot saved to ${file}`, path: file };
  }
  return {
    ok: result.ok,
    message: result.ok ? 'Screenshot captured' : result.error,
    path: result.ok ? file : null,
  };
}

async function deepthink_mouse_move(args, ctx) {
  const { x, y } = args;
  const cmd =
    process.platform === 'win32'
      ? `powershell -c "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})"`
      : `xdotool mousemove ${x} ${y}`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_mouse_click(args, ctx) {
  const { x, y, button = 'left', double = false } = args;
  const btn = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
  const cmd =
    process.platform === 'win32'
      ? `powershell -c "Add-Type -Name U -Namespace W -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f,int x,int y,int c,int i);'; [W.U]::mouse_event(0x8001,${x},${y},0,0)"`
      : double
        ? `xdotool mousemove ${x} ${y} click --repeat 2 ${btn}`
        : `xdotool mousemove ${x} ${y} click ${btn}`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_type_text(args, ctx) {
  const { text, delay = 0 } = args;
  const escaped = String(text).replace(/'/g, "'\\''");
  const cmd =
    process.platform === 'win32'
      ? `powershell -c "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('${text.replace(/'/g, "''")}')"`
      : `xdotool type --delay ${delay} '${escaped}'`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_keyboard(args, ctx) {
  const { key, modifiers = [] } = args;
  const combo = modifiers.length ? `${modifiers.join('+')}+${key}` : key;
  const cmd =
    process.platform === 'win32'
      ? `powershell -c "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('{${key}}')"`
      : `xdotool key ${combo}`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_get_clipboard(args, ctx) {
  const cmd =
    process.platform === 'win32'
      ? 'powershell -c "Get-Clipboard"'
      : process.platform === 'darwin'
        ? 'pbpaste'
        : 'xclip -selection clipboard -o';
  const result = await deepthink_shell({ command: cmd }, ctx);
  return { ok: result.ok, text: result.stdout || '' };
}

async function deepthink_set_clipboard(args, ctx) {
  const { text } = args;
  const escaped = String(text).replace(/'/g, "'\\''");
  const cmd =
    process.platform === 'win32'
      ? `powershell -c "Set-Clipboard '${text.replace(/'/g, "''")}'"`
      : process.platform === 'darwin'
        ? `echo '${escaped}' | pbcopy`
        : `echo '${escaped}' | xclip -selection clipboard`;
  const result = await deepthink_shell({ command: cmd }, ctx);
  return { ok: result.ok };
}

async function deepthink_system_info() {
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    username: os.userInfo().username,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    cpus: os.cpus().length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    uptime: os.uptime(),
    node: process.version,
    pid: process.pid,
  };
}

async function deepthink_list_processes(args, ctx) {
  const cmd = process.platform === 'win32' ? 'tasklist /fo csv /nh' : 'ps aux --no-headers';
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_kill_process(args, ctx) {
  const { pid, name } = args;
  if (pid == null && !name) {
    return { ok: false, error: 'kill_process: "pid" or "name" is required' };
  }
  const cmd =
    process.platform === 'win32'
      ? name
        ? `taskkill /IM "${name}" /F`
        : `taskkill /PID ${pid} /F`
      : name
        ? `pkill -f "${name}"`
        : `kill -9 ${pid}`;
  return deepthink_shell({ command: cmd }, ctx);
}

async function deepthink_env_var(args) {
  const { name, value } = args;
  if (!name) return { ok: false, error: 'env_var: "name" is required' };
  if (value !== undefined) {
    process.env[name] = String(value);
    return { ok: true, name, value: process.env[name] };
  }
  return { ok: true, name, value: process.env[name] };
}

async function deepthink_node_run(args, ctx) {
  const { code, file, timeout = 30000 } = args;
  if (file) return deepthink_shell({ command: `node "${file}"`, timeout }, ctx);
  if (typeof code !== 'string') {
    return { ok: false, error: 'node_run: "code" or "file" is required' };
  }
  const tmpFile = path.join(os.tmpdir(), `deepthink_node_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, code);
  const result = await deepthink_shell({ command: `node "${tmpFile}"`, timeout }, ctx);
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    // best-effort
  }
  dropTx(ctx, tmpFile);
  return result;
}

async function deepthink_python_run(args, ctx) {
  const { code, file, timeout = 30000 } = args;
  const runCmd = async (pyCmd) => {
    if (file) return deepthink_shell({ command: `${pyCmd} "${file}"`, timeout }, ctx);
    if (typeof code !== 'string') {
      return { ok: false, error: 'python_run: "code" or "file" is required' };
    }
    const tmpFile = path.join(os.tmpdir(), `deepthink_py_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
    fs.writeFileSync(tmpFile, code);
    const res = await deepthink_shell({ command: `${pyCmd} "${tmpFile}"`, timeout }, ctx);
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    dropTx(ctx, tmpFile);
    return res;
  };

  let result = await runCmd('python3');
  const errText = (result.stderr || '') + (result.stdout || '') + (result.error || '');
  const isNotFound =
    errText.includes('Python was not found') ||
    errText.includes('not recognized') ||
    errText.includes('not found') ||
    errText.includes('ENOENT');
  if (!result.ok && isNotFound) {
    result = await runCmd('python');
  }
  return result;
}

async function deepthink_git(args, ctx) {
  const { command, cwd } = args;
  if (!command) return { ok: false, error: 'git: "command" is required' };
  return deepthink_shell({ command: `git ${command}`, cwd: cwd || process.cwd() }, ctx);
}

async function deepthink_ai_analyze(args, ctx) {
  const { data, question, model } = args;
  if (!data || !question) {
    return { ok: false, error: 'ai_analyze: "data" and "question" are required' };
  }
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const prompt = `Analyze the following data and answer: ${question}\n\nData:\n${content.slice(0, 8000)}`;
  try {
    const analysis = await ctx.engine.generateJSON(prompt, { model });
    return { ok: true, analysis };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_analyze_image(args, ctx) {
  const { base64, question, model = 'llava' } = args;
  if (!base64) return { ok: false, error: 'analyze_image: "base64" is required' };
  try {
    const response = await ctx.engine.describe([base64], { model, prompt: question || 'What do you see in this image?' });
    return { ok: true, analysis: response };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deepthink_wait(args) {
  const { ms = 1000 } = args;
  const t = Math.max(0, Math.min(Number(ms) || 0, 60000));
  await new Promise((r) => setTimeout(r, t));
  return { ok: true, waited: t };
}

export default {
  deepthink_shell,
  deepthink_powershell,
  deepthink_js_execute,
  deepthink_cancel,
  deepthink_python_run,
  deepthink_node_run,
  deepthink_git,
  deepthink_read_file,
  deepthink_write_file,
  deepthink_list_dir,
  deepthink_create_dir,
  deepthink_delete_file,
  deepthink_copy_file,
  deepthink_rollback,
  deepthink_web_search,
  deepthink_web_fetch,
  deepthink_http_request,
  deepthink_open_url,
  deepthink_system_info,
  deepthink_list_processes,
  deepthink_kill_process,
  deepthink_env_var,
  deepthink_wait,
  deepthink_screenshot,
  deepthink_mouse_move,
  deepthink_mouse_click,
  deepthink_type_text,
  deepthink_keyboard,
  deepthink_get_clipboard,
  deepthink_set_clipboard,
  deepthink_ai_analyze,
  deepthink_analyze_image,
};
