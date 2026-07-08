import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
try {
  const pkgPath = path.join(__dirname, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.type !== 'module') {
      pkg.type = 'module';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
  }
} catch {}
import Deepthink from '../thinking/deepthink.js';
let pdfParse = null;
try {
  pdfParse = (await import('pdf-parse')).default;
} catch {
  console.warn('pdf-parse not found. Run: npm install pdf-parse');
  console.warn('   PDFs will be skipped until then.\n');
}
const window = 'hidden';
const GOAL = `
Do whatever you want. Explore the internet freely — research topics that fascinate you,
discover weird corners of the web, read about science, history, art, philosophy, or anything
that catches your eye. Follow your curiosity from page to page like a person with a
free afternoon and a browser. You can open new URLs whenever something interesting
comes up. Have genuine fun with this. The world is your oyster.
`.trim();
const strategy = 'cogito-2.1:671b-cloud';
const vision = 'qwen3-vl:235b-instruct-cloud';
const start = 'https://duckduckgo.com';
const log1 = path.join(__dirname, 'log.txt');
const max = 3;
const pdf = 12000;
const globalVisited = new Set();
const globalBlacklist = new Map();

function isBlacklisted(url) {
  return (globalBlacklist.get(url) || 0) >= 2;
}

function markFailed(url) {
  globalBlacklist.set(url, (globalBlacklist.get(url) || 0) + 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => sleep(Math.floor(Math.random() * (b - a + 1)) + a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(log1, line + '\n', 'utf8');
  } catch {}
}
async function jsRun(win, code) {
  try {
    return await win.webContents.executeJavaScript(code);
  } catch {
    return null;
  }
}

function focusRenderer(win) {
  try {
    if (!win.isDestroyed()) win.webContents.focus();
  } catch {}
}

function isPDFUrl(url) {
  return /\.pdf(\?.*)?$/i.test(url);
}
async function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: pdf
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}
async function pdfToHTML(url) {
  if (!pdfParse) return null;
  try {
    console.log(`Fetching PDF: ${url.slice(0, 80)}…`);
    const buf = await fetchBuffer(url);
    const data = await pdfParse(buf, {
      max: 0
    });
    const escaped = data.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>PDF: ${path.basename(url)}</title>
  <style>
    body {
      font-family: Georgia, serif;
      max-width: 860px;
      margin: 40px auto;
      padding: 0 20px;
      line-height: 1.7;
      color: #1a1a1a;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 0.95em;
    }

    .meta {
      color: #666;
      font-size: 0.85em;
      border-bottom: 1px solid #eee;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <h1>PDF extracted from:</h1>

  <div class="meta">
    ${url}<br>
    Pages: ${data.numpages} · Characters: ${data.text.length.toLocaleString()}
  </div>

  <pre>${escaped}</pre>
</body>
</html>
`;
    console.log(`PDF extracted: ${data.numpages} pages, ${data.text.length.toLocaleString()} chars`);
    return html;
  } catch (e) {
    console.warn(`PDF extraction failed: ${e.message}`);
    return null;
  }
}
async function smoothMove(win, sx, sy, ex, ey, steps = 13) {
  focusRenderer(win);
  for (let i = 1; i <= steps; i++) {
    const t = 1 - Math.pow(1 - i / steps, 3);
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(sx + (ex - sx) * t),
      y: Math.round(sy + (ey - sy) * t)
    });
    await sleep(8);
  }
}
async function realClick(win, x, y, cx, cy) {
  await smoothMove(win, cx, cy, x, y);
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x,
    y,
    button: 'left',
    clickCount: 1
  });
  await rand(55, 130);
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x,
    y,
    button: 'left',
    clickCount: 1
  });
  return {
    newCx: x,
    newCy: y
  };
}
async function realClickAndType(win, x, y, text, cx, cy) {
  await smoothMove(win, cx, cy, x, y);
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x,
    y,
    button: 'left',
    clickCount: 3
  });
  await rand(40, 80);
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x,
    y,
    button: 'left',
    clickCount: 3
  });
  await sleep(200);
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Delete'
  });
  await rand(30, 60);
  win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'Delete'
  });
  await sleep(80);
  for (const ch of text) {
    win.webContents.sendInputEvent({
      type: 'char',
      keyCode: ch
    });
    await rand(28, 105);
  }
  await sleep(150);
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'Enter'
  });
  await rand(40, 80);
  win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'Enter'
  });
  return {
    newCx: x,
    newCy: y
  };
}
async function realKeyPress(win, key) {
  focusRenderer(win);
  win.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: key
  });
  await rand(45, 90);
  win.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: key
  });
}
async function realScroll(win, x, y, deltaY) {
  focusRenderer(win);
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY: -deltaY
  });
  await sleep(600);
}
async function waitForContent(win, minLen = 300, maxMs = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (win.isDestroyed()) return false;
    if (!win.webContents.isLoading()) {
      const len = (await jsRun(win, 'document.body ? document.body.innerHTML.length : 0')) || 0;
      if (len >= minLen) return true;
    }
    await sleep(350);
  }
  return false;
}
async function inspectDOM(win) {
  const r = await jsRun(win, `
    (() => {
      const vw=window.innerWidth, vh=window.innerHeight;
      const vis=el=>{const r=el.getBoundingClientRect();return r.width>4&&r.height>4&&r.top0&&r.left0};
      const mid=el=>{const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}};
      const txt=el=>(el.textContent||el.value||el.placeholder||el.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');
      return {
        title:      document.title,
        url:        window.location.href,
        readyState: document.readyState,
        bodyLength: document.body?document.body.innerHTML.length:0,
        scrollY:    window.scrollY,
        pageHeight: document.body?document.body.scrollHeight:0,
        inputs:   Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,select')).filter(vis).slice(0,12).map(el=>({...mid(el),type:el.type||'text',placeholder:el.placeholder||'',value:el.value||'',name:el.name||''})),
        buttons:  Array.from(document.querySelectorAll('button,[role=button],[type=submit]')).filter(vis).slice(0,20).map(el=>({...mid(el),text:txt(el)})),
        links:    Array.from(document.querySelectorAll('a[href]')).filter(vis).slice(0,25).map(el=>({...mid(el),text:txt(el),href:(el.href||'')})),
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0,8).map(h=>h.textContent.trim()),
        pageText: (document.body?document.body.innerText:''),
        overlays: Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],.modal,.popup,.overlay')).filter(vis).slice(0,5).map(el=>({text:txt(el),tag:el.tagName.toLowerCase()})),
      };
    })()
  `);
  return r || {
    title: 'unknown',
    url: 'unknown',
    readyState: 'loading',
    bodyLength: 0,
    inputs: [],
    buttons: [],
    links: [],
    headings: [],
    pageText: '',
    overlays: [],
    scrollY: 0,
    pageHeight: 0
  };
}
async function visionDescribe(dt, buf) {
  try {
    const r = await dt.callChat([{
      role: 'user',
      content: 'Describe this screen in 2-3 sentences. What is on the page?',
      images: [buf.toString('base64')]
    }], false, null, {
      model: vision,
      think: false
    });
    return (r.content || '').trim();
  } catch (e) {
    return `(vision error: ${e.message})`;
  }
}
const MOODS = ['curious', 'excited', 'contemplative', 'restless', 'bored', 'delighted', 'frustrated'];
class Memory {
  constructor(label = 'main') {
    this.label = label;
    this.max = 60;
    this.log = [];
    this.fullLog = [];
    this.failStreak = 0;
    this.repeatCount = 0;
    this.lastSig = '';
    this.discoveries = [];
    this.visitedUrls = new Set();
    this.topicHistory = [];
    this.loopCount = 0;
    this.mood = 'curious';
    this.currentFocus = '';
    this.sameTopicCount = 0;
    this.lastTopic = '';
  }
  push(action, x, y, text, outcome, url, note = '') {
    const entry = {
      action,
      x,
      y,
      text: text || '',
      outcome,
      url: url || '',
      t: new Date().toISOString().slice(11, 19),
      note
    };
    this.log.push(entry);
    this.fullLog.push(entry);
    if (this.log.length > this.max) this.log.shift();
    const sig = `${action}|${x}|${y}|${text || ''}`;
    this.repeatCount = sig === this.lastSig ? this.repeatCount + 1 : 0;
    this.lastSig = sig;
    const bad = ['error', 'no_change', 'unknown_action', 'blank_skip', 'blacklisted'];
    this.failStreak = bad.includes(outcome) ? this.failStreak + 1 : 0;
    if (note) this.discoveries.push(`[${entry.t}] ${note}`);
    if (url) this.visitedUrls.add(url);
    this.loopCount++;
    const recent = this.log.slice(-5).map(e => e.outcome);
    const fails = recent.filter(o => bad.includes(o)).length;
    if (fails >= 3) this.mood = 'frustrated';
    else if (fails >= 1) this.mood = 'restless';
    else if (note) this.mood = 'excited';
    else if (this.loopCount % 9 === 0) this.mood = MOODS[Math.floor(Math.random() * MOODS.length)];
  }
  urlTopic(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace('www.', '') + u.pathname.split('/').slice(0, 2).join('/');
    } catch {
      return url;
    }
  }
  trackTopicDrift(url) {
    const topic = this.urlTopic(url);
    if (topic === this.lastTopic) this.sameTopicCount++;
    else {
      this.sameTopicCount = 0;
      this.lastTopic = topic;
    }
    this.topicHistory.push(topic);
    if (this.topicHistory.length > 30) this.topicHistory.shift();
  }
  toText() {
    return this.log.slice(-20).map(e => `[${e.t}] ${e.action}${e.x != null ? ` @(${e.x},${e.y})` : ''}${e.text ? ` "${e.text}"` : ''}  →  ${e.outcome}  |  ${e.url}${e.note ? `${e.note}` : ''}`).join('\n') || '(no actions yet)';
  }
  warning() {
    const w = [];
    if (this.repeatCount >= 2) w.push(`SAME ACTION REPEATED ${this.repeatCount + 1}x — do something different.`);
    if (this.failStreak >= 3) w.push(`${this.failStreak} consecutive failures — pivot.`);
    if (this.failStreak >= 7) w.push(`CRITICAL: navigate somewhere completely new.`);
    if (this.sameTopicCount >= 8) w.push(`TOPIC FATIGUE: ${this.sameTopicCount} loops on "${this.lastTopic}" — explore something fresh.`);
    return w.join('\n');
  }
  toSummaryText() {
    return this.fullLog.map(e => `[${e.t}] ${e.action} → ${e.url}${e.note ? ` | NOTE: ${e.note}` : ''}`).join('\n');
  }
}
async function compressGoal(dt, memory) {
  if (memory.fullLog.length < 5) return;
  const discoveries = memory.discoveries.slice(-10).join('\n') || '(none yet)';
  const recentUrls = [...memory.visitedUrls].slice(-15).join('\n');
  const prompt = `You are an AI explorer mid-session. Compress your recent browsing into a short first-person "current focus" (2-3 sentences max) that captures:\n` + `1. What you've been learning about\n2. What you specifically want to find next\n3. One unrelated topic that's been tugging at your curiosity\n\n` + `Recent discoveries:\n${discoveries}\n\nRecent sites:\n${recentUrls}\n\nReply with ONLY the 2-3 sentence focus statement.`;
  try {
    const r = await dt.callChat([{
      role: 'user',
      content: prompt
    }], false, null, {
      model: strategy,
      think: false
    });
    const focus = (r.content || '').trim();
    if (focus) {
      memory.currentFocus = focus;
      console.log(`[35mFocus compressed:[0m${focus.slice(0, 100)}…`);
    }
  } catch {}
}
async function decideAction(dt, dom, memory, visionNote, goal, tabLabel) {
  const warn = memory.warning();
  const inputs = (dom.inputs || []).map((el, i) => `  INPUT[${i}]  "${el.placeholder || el.name}" value="${el.value}" @(${el.x},${el.y}) ${el.w}x${el.h}px`).join('\n');
  const buttons = (dom.buttons || []).map((el, i) => `  BTN[${i}]   "${el.text}" @(${el.x},${el.y})`).join('\n');
  const links = (dom.links || []).slice(0, 15).map((el, i) => `  LINK[${i}]  "${el.text}" @(${el.x},${el.y})  ${el.href}`).join('\n');
  const olays = (dom.overlays || []).map((el, i) => `  OVERLAY[${i}] <${el.tag}> "${el.text}"`).join('\n') || '  (none)';
  const focusLine = memory.currentFocus ? `\nCURRENT FOCUS (evolved from what I've been exploring):\n${memory.currentFocus}` : '';
  const prompt = `You are an autonomous web explorer in tab [${tabLabel}]. You browse freely, like a curious human with a free afternoon.\n\n` + `ORIGINAL GOAL: ${goal}\n${focusLine}\nMY MOOD RIGHT NOW: ${memory.mood}\nSESSION LOOP: ${memory.loopCount}\n\n` + `=== PAGE STATE ===\nTitle:     ${dom.title}\nURL:       ${dom.url}\nBody size: ${dom.bodyLength} chars\n` + `Scroll:    ${dom.scrollY}px of ${dom.pageHeight}px\nHeadings:  ${(dom.headings || []).join(' | ') || '(none)'}\n\n` + `INPUT FIELDS:\n${inputs || '  (none)'}\n\nBUTTONS:\n${buttons || '  (none)'}\n\nLINKS:\n${links || '  (none)'}\n\nOVERLAYS:\n${olays}\n\n` + `PAGE TEXT:\n${dom.pageText || ''}\n\nVisual: ${visionNote || '(not taken)'}\n${warn ? `WARNING:${warn}` : ''}\n\n` + `=== ACTION HISTORY ===\n${memory.toText()}\n\n` + `=== AVAILABLE ACTIONS ===\nnavigate → {action, text}\nclick → {action, x, y}\nclick_and_type → {action, x, y, text}\nkey_press → {action, key}\nscroll → {action, y}\n\n` + `Output ONLY valid JSON:\n{"reasoning":"short first-person thought","action":"navigate","x":null,"y":null,"text":"https://...","key":"","note":"specific interesting thing you noticed, or null"}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await dt.callChat([{
        role: 'user',
        content: prompt
      }], false, null, {
        model: strategy,
        think: true,
        format: 'json'
      });
      const match = (r.content || '').match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no JSON');
      const p = JSON.parse(match[0]);
      if (p.action === 'click' || p.action === 'click_and_type') {
        const ok = typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y);
        if (!ok) {
          const all = [...(dom.inputs || []), ...(dom.buttons || []), ...(dom.links || [])];
          if (all.length > 0) {
            p.x = all[0].x;
            p.y = all[0].y;
            console.warn(`\x1b[33m[${tabLabel}][AUTO-FIX] coords → (${p.x},${p.y})\x1b[0m`);
          } else {
            p.action = 'navigate';
            p.text = dom.bodyLength < 500 ? 'https://duckduckgo.com' : dom.url;
            p.x = null;
            p.y = null;
          }
        }
        if (p.x != null) p.x = clamp(Math.round(p.x), 1, 1279);
        if (p.y != null) p.y = clamp(Math.round(p.y), 1, 719);
      }
      return p;
    } catch (e) {
      console.warn(`\x1b[33m[${tabLabel}][STRATEGY] attempt ${attempt + 1}/3: ${e.message}\x1b[0m`);
    }
  }
  return {
    reasoning: 'fallback after 3 failures',
    action: 'navigate',
    x: null,
    y: null,
    text: 'https://duckduckgo.com',
    key: '',
    note: null
  };
}
class Control {
  constructor(win, dt, label, windowManager) {
    this.win = win;
    this.dt = dt;
    this.label = label;
    this.wm = windowManager;
    this.memory = new Memory(label);
    this.cx = 640;
    this.cy = 360;
    this.count = 0;
    this.active = true;
    this.lastContentLen = 0;
    win.webContents.setWindowOpenHandler(({
      url
    }) => {
      if (isPDFUrl(url)) {
        console.log(`\x1b[36m[${this.label}] Intercepting PDF link — extracting inline\x1b[0m`);
        this._loadPDF(url);
      } else {
        console.log(`\x1b[36m[${this.label}] Wants new tab: ${url.slice(0, 70)}\x1b[0m`);
        this.wm.openTab(url, this.dt);
      }
      return {
        action: 'deny'
      };
    });
  }
  stop() {
    this.active = false;
  }
  async _loadPDF(url) {
    if (isBlacklisted(url)) {
      console.log(`PDF blacklisted, skipping:${url.slice(0, 60)}`);
      return;
    }
    const html = await pdfToHTML(url);
    if (html) {
      const dataURL = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
      try {
        await this.win.loadURL(dataURL);
      } catch {}
    } else {
      markFailed(url);
      console.log(`PDF failed — blacklisted:${url.slice(0, 60)}`);
    }
  }
  async run() {
    if (!this.active || this.win.isDestroyed()) return;
    this.count++;
    try {
      await waitForContent(this.win, 300, 9000);
      const dom = await inspectDOM(this.win);
      this.memory.trackTopicDrift(dom.url);
      if (this.count % 20 === 0 && this.count > 0) await compressGoal(this.dt, this.memory);
      console.log(`\n\x1b[36m[${this.label}]\x1b[0m Loop ${this.count} — ${dom.title.slice(0, 60)}`);
      console.log(`${dom.url}`);
      console.log(`Body:${dom.bodyLength} | Scroll: ${dom.scrollY}/${dom.pageHeight} | Mood: ${this.memory.mood}`);
      console.log(`${dom.inputs.length} inputs · ${dom.buttons.length} buttons · ${dom.links.length} links`);
      if (dom.bodyLength < 200) {
        markFailed(dom.url);
        console.log(`Blank page (${dom.bodyLength} chars) — escaping to DuckDuckGo`);
        this.memory.push('blank_skip', null, null, dom.url, 'blank_skip', dom.url, null);
        await this.win.loadURL('https://duckduckgo.com').catch(() => {});
        await sleep(2000);
        if (this.active && !this.win.isDestroyed()) setTimeout(() => this.run(), 1200);
        return;
      }
      let visionNote = null;
      if (dom.overlays.length > 0) {
        const img = await this.win.webContents.capturePage().catch(() => null);
        if (img) {
          visionNote = await visionDescribe(this.dt, img.toJPEG(72));
          console.log(`${visionNote}`);
        }
      }
      const d = await decideAction(this.dt, dom, this.memory, visionNote, GOAL, this.label);
      console.log(`${d.reasoning}`);
      console.log(`[33m${d.action}\x1b[0m${d.x != null ? ` @(${d.x},${d.y})` : ''}${d.text ? ` → "${d.text}"` : ''}${d.key ? ` key=${d.key}` : ''}`);
      if (d.note) console.log(`[32m${d.note}\x1b[0m`);
      log(`[${this.label}] ${d.action} | ${d.reasoning} | url=${dom.url}`);
      focusRenderer(this.win);
      let outcome = 'ok';
      switch (d.action) {
        case 'click': {
          const res = await realClick(this.win, d.x, d.y, this.cx, this.cy);
          this.cx = res.newCx;
          this.cy = res.newCy;
          await sleep(600);
          break;
        }
        case 'click_and_type': {
          const res = await realClickAndType(this.win, d.x, d.y, d.text || '', this.cx, this.cy);
          this.cx = res.newCx;
          this.cy = res.newCy;
          await sleep(900);
          break;
        }
        case 'type': {
          for (const ch of d.text || '') {
            this.win.webContents.sendInputEvent({
              type: 'char',
              keyCode: ch
            });
            await rand(28, 100);
          }
          break;
        }
        case 'key_press': {
          await realKeyPress(this.win, d.key || d.text || 'Enter');
          await sleep(400);
          break;
        }
        case 'scroll': {
          await realScroll(this.win, this.cx, this.cy, typeof d.y === 'number' ? d.y : 400);
          break;
        }
        case 'navigate': {
          let url = (d.text || '').trim();
          if (!url) {
            outcome = 'error';
            break;
          }
          if (!url.startsWith('http')) url = 'https://' + url;
          if (isBlacklisted(url)) {
            console.log(`Skipping blacklisted:${url.slice(0, 60)}`);
            outcome = 'blacklisted';
            break;
          }
          globalVisited.add(url);
          if (isPDFUrl(url)) {
            await this._loadPDF(url);
            await sleep(1500);
          } else {
            await this.win.loadURL(url).catch(e => {
              console.warn(`loadURL failed:${e.message}`);
              markFailed(url);
              outcome = 'error';
            });
            if (outcome !== 'error') await sleep(2500);
          }
          break;
        }
        default:
          console.warn(`[${this.label}] Unknown action: ${d.action}`);
          outcome = 'unknown_action';
      }
      const finalUrl = (await jsRun(this.win, 'window.location.href')) || dom.url;
      const newLen = (await jsRun(this.win, 'document.body ? document.body.innerHTML.length : 0')) || 0;
      if (outcome === 'ok' && Math.abs(newLen - this.lastContentLen) < 50 && !['scroll', 'key_press'].includes(d.action)) {
        outcome = 'no_change';
      }
      this.lastContentLen = newLen;
      this.memory.push(d.action, d.x, d.y, d.text, outcome, finalUrl, d.note || '');
    } catch (err) {
      console.error(`\x1b[31m[${this.label}] Loop error: ${err.message}\x1b[0m`);
      this.memory.push('loop_error', null, null, err.message, 'crash', 'unknown');
    }
    if (this.active && !this.win.isDestroyed()) {
      const pause = 1200 + Math.random() * 1600;
      setTimeout(() => this.run(), pause);
    }
  }
}
class Window {
  constructor(dt) {
    this.dt = dt;
    this.tabs = new Map();
    this.count = 0;
  }
  _makeWindow() {
    const win = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });
    win.webContents.setAudioMuted(true);
    if (window === 'normal') win.show();
    if (window === 'inactive') win.showInactive();
    win.on('closed', () => {
      const loop = this.tabs.get(win);
      if (loop) {
        loop.stop();
        this.tabs.delete(win);
      }
    });
    return win;
  }
  _pruneWorstTab() {
    let worst = null,
      lowestScore = Infinity;
    for (const [win, loop] of this.tabs) {
      if (loop.label === 'main') continue;
      const recent = loop.memory.log.slice(-10);
      const good = recent.filter(e => !['error', 'blank_skip', 'no_change', 'blacklisted', 'crash'].includes(e.outcome)).length;
      const score = good - loop.memory.failStreak * 2;
      if (score < lowestScore) {
        lowestScore = score;
        worst = [win, loop];
      }
    }
    if (worst) {
      const [win, loop] = worst;
      console.log(`\x1b[35m[WindowManager] Pruning ${loop.label} (productivity score: ${lowestScore})\x1b[0m`);
      loop.stop();
      this.tabs.delete(win);
      if (!win.isDestroyed()) win.close();
    }
  }
  openTab(url, dt) {
    if (this.tabs.size >= max) this._pruneWorstTab();
    if (globalVisited.has(url)) {
      console.log(`\x1b[35m[WindowManager] Skipping already-visited: ${url.slice(0, 60)}\x1b[0m`);
      return null;
    }
    if (isBlacklisted(url)) {
      console.log(`\x1b[35m[WindowManager] Skipping blacklisted: ${url.slice(0, 60)}\x1b[0m`);
      return null;
    }
    this.count++;
    const label = `tab-${this.count}`;
    const win = this._makeWindow();
    const loop = new Control(win, dt || this.dt, label, this);
    this.tabs.set(win, loop);
    globalVisited.add(url);
    console.log(`\x1b[35m[WindowManager] Opened ${label}: ${url.slice(0, 70)} (${this.tabs.size}/${max} tabs)\x1b[0m`);
    if (isPDFUrl(url)) {
      loop._loadPDF(url).then(() => loop.run());
    } else {
      win.loadURL(url).then(() => loop.run()).catch(err => {
        console.error(`[${label}] Load error: ${err.message}`);
        markFailed(url);
      });
    }
    return loop;
  }
  stopAll() {
    for (const [, loop] of this.tabs) loop.stop();
  }
  allMemories() {
    return [...this.tabs.values()].map(l => l.memory);
  }
}
async function generateSummary(dt, memories) {
  console.log('\n\n' + '═'.repeat(60));
  console.log('  Generating reflective session summary…');
  console.log('═'.repeat(60) + '\n');
  const allDiscoveries = memories.flatMap(m => m.discoveries);
  const allLogs = memories.map(m => `[${m.label}]\n${m.toSummaryText()}`).join('\n\n');
  const totalActions = memories.reduce((s, m) => s + m.fullLog.length, 0);
  const uniqueUrls = new Set(memories.flatMap(m => m.fullLog.map(e => e.url))).size;
  const allFocuses = memories.map(m => m.currentFocus).filter(Boolean).join('\n');
  const prompt = `You are summarizing an autonomous AI browsing session. Write a warm, reflective first-person journal entry.\n\n` + `SESSION STATS:\n- Total actions: ${totalActions}\n- Unique pages visited: ${uniqueUrls}\n- Tabs used: ${memories.length}\n` + `- Evolved focus statements:\n${allFocuses || '  (none recorded)'}\n` + `- Things I noted as interesting:\n${allDiscoveries.length > 0 ? allDiscoveries.map(d => '  • ' + d).join('\n') : '  (none recorded)'}\n\n` + `FULL ACTION LOG:\n${allLogs.slice(0, 8000)}\n\n` + `Write a genuine journal entry: themes, rabbit holes, frustrations, delights. 4-6 paragraphs. First person, conversational.`;
  try {
    const r = await dt.callChat([{
      role: 'user',
      content: prompt
    }], false, null, {
      model: strategy,
      think: true
    });
    return (r.content || '').trim();
  } catch (e) {
    return `(Summary failed: ${e.message})\n\nRaw discoveries:\n${allDiscoveries.join('\n')}`;
  }
}
async function init() {
  await app.whenReady();
  const dt = new Deepthink(strategy, [process.env.OLLAMA_API_KEY || ''], {}, Infinity, vision);
  const wm = new Window(dt);
  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\x1b[33m[Shutdown] ${reason} — stopping all loops…\x1b[0m`);
    wm.stopAll();
    await sleep(600);
    const memories = wm.allMemories();
    if (memories.some(m => m.fullLog.length > 0)) {
      const summary = await generateSummary(dt, memories);
      const summaryPath = path.join(__dirname, `summary_${Date.now()}.txt`);
      console.log('\n' + '═'.repeat(60));
      console.log('  SESSION SUMMARY');
      console.log('═'.repeat(60));
      console.log('\n' + summary + '\n');
      console.log('═'.repeat(60) + '\n');
      fs.writeFileSync(summaryPath, summary, 'utf8');
      console.log(`Summary saved to: ${summaryPath}`);
    } else {
      console.log('[Shutdown] No actions recorded — no summary.');
    }
    app.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  app.on('before-quit', () => {
    if (!shuttingDown) shutdown('App closing');
  });
  console.log(`Free Explorer v2 — Human Mode`);
  console.log(`Window:${window}| Audio: muted`);
  console.log(`Tab budget:${max} concurrent tabs`);
  console.log(`PDF support:${pdfParse ? 'enabled (pdf-parse)' : 'disabled — run: npm install pdf-parse'}`);
  console.log(`Press Ctrl+C to stop and get a reflective journal summary.`);
  const mainLoop = wm.openTab(start, dt);
  if (mainLoop) mainLoop.label = 'main';
}
init();