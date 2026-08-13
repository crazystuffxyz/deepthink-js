// src/mcp-server/skills.js
// skill subsystem: a small registry + built-in skills that turn a goal or raw
// data into a polished artifact (csv, xlsx, markdown, html, json array). one
// module, no filesystem discovery. deps loaded lazily so a missing one can't
// crash the whole server at import time.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ---- shared bits ----

// default output dir. skills write artifacts here unless the caller overrides.
const REPORTS_DIR = path.join(process.cwd(), 'data', 'reports');

// html-escape for safe embedding in svg/markup
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
}

// pick a default out dir + filename w/ ext, ensure it exists
function resolveOut({ outDir, filename, ext }) {
  const dir = outDir || REPORTS_DIR;
  let name = filename || `report-${Date.now()}.${ext}`;
  if (!name.toLowerCase().endsWith(`.${ext}`)) name += `.${ext}`;
  return { dir, path: path.join(dir, name), filename: name };
}

// excel-style column letter helpers (also used by chart embed anchors)
function numToColLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colLetterToNum(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

// safe row filter for csv — no eval/Function.
// supports: r.key, r["key"], numbers, strings, true/false/null,
// comparisons, && || !, unary +/-, arithmetic, parens.
// anything weirder keeps the row (fail-open like the old try/catch).
function compileRowFilter(expr) {
  if (expr == null || expr === '') return () => true;
  if (typeof expr !== 'string') return () => true;
  const src = expr.trim();
  if (!src) return () => true;
  // hard reject known escape hatches
  if (/\b(require|process|globalThis|global|Function|eval|import|export|constructor|__proto__|prototype)\b/.test(src)) {
    return () => true;
  }
  // only allow a small alphabet of tokens
  if (!/^[a-zA-Z0-9_\s.\[\]'"+\-*/%<>=!&|()?:.,]+$/.test(src)) {
    return () => true;
  }

  let i = 0;
  const peek = () => src[i];
  const eat = () => src[i++];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = (msg) => {
    throw new Error(msg || 'bad filter');
  };

  function parsePrimary(row) {
    skip();
    const c = peek();
    if (c === '(') {
      eat();
      const v = parseOr(row);
      skip();
      if (peek() !== ')') fail('unclosed (');
      eat();
      return v;
    }
    if (c === '"' || c === "'") {
      const q = eat();
      let s = '';
      while (i < src.length && peek() !== q) {
        if (peek() === '\\') {
          eat();
          s += eat() || '';
        } else {
          s += eat();
        }
      }
      if (peek() !== q) fail('unclosed string');
      eat();
      return s;
    }
    // number
    if (c === '.' || (c >= '0' && c <= '9')) {
      let n = '';
      while (i < src.length && /[0-9.]/.test(peek())) n += eat();
      const num = Number(n);
      if (Number.isNaN(num)) fail('bad number');
      return num;
    }
    // ident / keyword / r.field
    if (/[a-zA-Z_]/.test(c || '')) {
      let id = '';
      while (i < src.length && /[a-zA-Z0-9_]/.test(peek())) id += eat();
      if (id === 'true') return true;
      if (id === 'false') return false;
      if (id === 'null') return null;
      if (id === 'r') {
        skip();
        if (peek() === '.') {
          eat();
          skip();
          let key = '';
          if (!/[a-zA-Z_]/.test(peek() || '')) fail('expected field after r.');
          while (i < src.length && /[a-zA-Z0-9_]/.test(peek())) key += eat();
          return row != null ? row[key] : undefined;
        }
        if (peek() === '[') {
          eat();
          skip();
          const key = parsePrimary(row);
          skip();
          if (peek() !== ']') fail('unclosed [');
          eat();
          return row != null ? row[key] : undefined;
        }
        return row;
      }
      fail('unknown ident: ' + id);
    }
    fail('unexpected: ' + c);
  }

  function parseUnary(row) {
    skip();
    if (peek() === '!') {
      eat();
      return !parseUnary(row);
    }
    if (peek() === '-') {
      eat();
      return -Number(parseUnary(row));
    }
    if (peek() === '+') {
      eat();
      return +Number(parseUnary(row));
    }
    return parsePrimary(row);
  }

  function parseMul(row) {
    let left = parseUnary(row);
    for (;;) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') break;
      eat();
      const right = parseUnary(row);
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parseAdd(row) {
    let left = parseMul(row);
    for (;;) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') break;
      eat();
      const right = parseMul(row);
      if (op === '+') left = left + right;
      else left = left - right;
    }
    return left;
  }

  function parseCmp(row) {
    const left = parseAdd(row);
    skip();
    // multi-char ops first
    const rest = src.slice(i);
    const ops = ['===', '!==', '==', '!=', '<=', '>=', '<', '>'];
    for (const op of ops) {
      if (rest.startsWith(op)) {
        i += op.length;
        const right = parseAdd(row);
        if (op === '===') return left === right;
        if (op === '!==') return left !== right;
        if (op === '==') return left == right; // eslint-disable-line eqeqeq
        if (op === '!=') return left != right; // eslint-disable-line eqeqeq
        if (op === '<=') return left <= right;
        if (op === '>=') return left >= right;
        if (op === '<') return left < right;
        if (op === '>') return left > right;
      }
    }
    return left;
  }

  function parseAnd(row) {
    let left = parseCmp(row);
    for (;;) {
      skip();
      if (src.slice(i, i + 2) !== '&&') break;
      i += 2;
      // short-circuit
      const right = parseCmp(row);
      left = left && right;
    }
    return left;
  }

  function parseOr(row) {
    let left = parseAnd(row);
    for (;;) {
      skip();
      if (src.slice(i, i + 2) !== '||') break;
      i += 2;
      const right = parseAnd(row);
      left = left || right;
    }
    return left;
  }

  // compile once — parse tree is re-run per row via the same source cursor reset
  return (row) => {
    try {
      i = 0;
      const v = parseOr(row);
      skip();
      if (i < src.length) return true; // trailing junk -> keep row
      return !!v;
    } catch {
      return true;
    }
  };
}

// ---- svg charts (bar/line/area/pie/doughnut/scatter), no canvas ----

const PALETTE = [
  '#4F81BD',
  '#F79646',
  '#9BBB59',
  '#8064A2',
  '#4BACC6',
  '#F79646',
  '#2C4D75',
  '#772C2C',
  '#5F7530',
  '#2D566F',
];

const color = (s, i) => s.color || PALETTE[i % PALETTE.length];

function axes(values, w, h) {
  const pad = { l: 60, r: 20, t: 36, b: 60 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const ticks = 5;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => ({
    v: min + (range * i) / ticks,
    y: pad.t + innerH - ((min + (range * i) / ticks - min) / range) * innerH,
  }));
  const yLines = yTicks
    .map(
      (t) => `<line x1="${pad.l}" y1="${t.y}" x2="${pad.l + innerW}" y2="${t.y}" stroke="#e0e0e0" stroke-width="1"/>`,
    )
    .join('');
  const yLabels = yTicks
    .map(
      (t) =>
        `<text x="${pad.l - 6}" y="${t.y + 4}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#666" text-anchor="end">${Number(t.v.toFixed(2))}</text>`,
    )
    .join('');
  const zeroY = pad.t + innerH - ((0 - min) / range) * innerH;
  const zeroLine = `<line x1="${pad.l}" y1="${zeroY}" x2="${pad.l + innerW}" y2="${zeroY}" stroke="#333" stroke-width="1"/>`;
  return { pad, innerW, innerH, min, max, range, zeroY, yLines, yLabels, zeroLine };
}

function drawBar(w, h, labels, series, opts = {}) {
  const a = axes(
    series.flatMap((s) => s.values),
    w,
    h,
  );
  const groupW = a.innerW / Math.max(1, labels.length);
  const barGap = 2;
  const barW = Math.max(2, (groupW - barGap * (series.length + 1)) / Math.max(1, series.length));
  const bars = [];
  labels.forEach((lbl, i) => {
    series.forEach((s, si) => {
      const v = Number(s.values[i] || 0);
      const x = a.pad.l + i * groupW + barGap + si * (barW + barGap);
      const y1 = a.pad.t + a.innerH - ((v - a.min) / a.range) * a.innerH;
      const top = Math.min(a.zeroY, y1);
      const bh = Math.max(1, Math.abs(y1 - a.zeroY));
      bars.push(
        `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color(s, si)}"><title>${esc(lbl)} / ${esc(s.name)}: ${v}</title></rect>`,
      );
    });
  });
  const xLabels = labels
    .map((lbl, i) => {
      const x = a.pad.l + i * groupW + groupW / 2;
      const y = a.pad.t + a.innerH + 16;
      return `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#666" text-anchor="middle">${esc(lbl)}</text>`;
    })
    .join('');
  const legend = series
    .map((s, si) => {
      const x = a.pad.l + si * 90;
      const y = a.pad.t - 18;
      return `<rect x="${x}" y="${y - 8}" width="10" height="10" fill="${color(s, si)}"/><text x="${x + 14}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#333">${esc(s.name)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    ${opts.title ? `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#222" font-weight="bold">${esc(opts.title)}</text>` : ''}
    ${legend}
    ${a.yLines}${a.yLabels}${a.zeroLine}${bars.join('')}${xLabels}
  </svg>`;
}

function drawLine(w, h, labels, series, opts = {}) {
  const a = axes(
    series.flatMap((s) => s.values),
    w,
    h,
  );
  const step = labels.length > 1 ? a.innerW / (labels.length - 1) : 0;
  const paths = series
    .map((s, si) => {
      const c = color(s, si);
      const pts = s.values.map((v, i) => [
        a.pad.l + i * step,
        a.pad.t + a.innerH - ((Number(v || 0) - a.min) / a.range) * a.innerH,
      ]);
      if (!pts.length) return '';
      const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      let fill = '';
      if (opts.area) {
        const last = pts[pts.length - 1];
        const first = pts[0];
        const dFill = `${d} L${last[0].toFixed(1)},${(a.pad.t + a.innerH).toFixed(1)} L${first[0].toFixed(1)},${(a.pad.t + a.innerH).toFixed(1)} Z`;
        fill = `<path d="${dFill}" fill="${c}" fill-opacity="0.2"/>`;
      }
      const dots = pts
        .map(
          ([x, y], i) =>
            `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${c}"><title>${esc(labels[i])} / ${esc(s.name)}: ${Number(s.values[i] || 0)}</title></circle>`,
        )
        .join('');
      return `${fill}<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>${dots}`;
    })
    .join('');
  const xLabels = labels
    .map((lbl, i) => {
      const x = a.pad.l + i * step;
      const y = a.pad.t + a.innerH + 16;
      return `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#666" text-anchor="middle">${esc(lbl)}</text>`;
    })
    .join('');
  const legend = series
    .map((s, si) => {
      const x = a.pad.l + si * 90;
      const y = a.pad.t - 18;
      const c = color(s, si);
      return `<line x1="${x}" y1="${y - 3}" x2="${x + 12}" y2="${y - 3}" stroke="${c}" stroke-width="2"/><circle cx="${x + 6}" cy="${y - 3}" r="3" fill="${c}"/><text x="${x + 18}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#333">${esc(s.name)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    ${opts.title ? `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#222" font-weight="bold">${esc(opts.title)}</text>` : ''}
    ${legend}${a.yLines}${a.yLabels}${paths}${xLabels}
  </svg>`;
}

function drawScatter(w, h, labels, series, opts = {}) {
  const pad = { l: 60, r: 20, t: 36, b: 60 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const xs = series.flatMap((s) => s.values.map((v, i) => Number(s.x?.[i] ?? i)));
  const ys = series.flatMap((s) => s.values);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(1, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const projX = (v) => pad.l + ((v - minX) / rangeX) * innerW;
  const projY = (v) => pad.t + innerH - ((v - minY) / rangeY) * innerH;
  const dots = series
    .flatMap((s, si) => {
      const c = color(s, si);
      return s.values.map((y, i) => {
        const x = Number(s.x?.[i] ?? i);
        return `<circle cx="${projX(x).toFixed(1)}" cy="${projY(Number(y || 0)).toFixed(1)}" r="3" fill="${c}" fill-opacity="0.7"><title>(${x}, ${Number(y || 0)})</title></circle>`;
      });
    })
    .join('');
  const legend = series
    .map((s, si) => {
      const x = pad.l + si * 90;
      const y = pad.t - 18;
      const c = color(s, si);
      return `<circle cx="${x + 5}" cy="${y - 3}" r="4" fill="${c}"/><text x="${x + 14}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#333">${esc(s.name)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    ${opts.title ? `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#222" font-weight="bold">${esc(opts.title)}</text>` : ''}
    ${legend}
    <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="#333"/>
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" stroke="#333"/>
    ${dots}
  </svg>`;
}

function drawPie(w, h, labels, series, opts = {}) {
  // pie takes only the first series
  const values = (series[0]?.values || []).map(Number);
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const cx = w / 2;
  const cy = h / 2 + 6;
  const r = Math.min(w, h) / 2 - 60;
  let angle = -Math.PI / 2;
  const slices = values
    .map((v, i) => {
      const frac = Math.max(0, v) / total;
      const next = angle + frac * 2 * Math.PI;
      const c = series[0]?.color || PALETTE[i % PALETTE.length];
      const a0 = angle;
      const a1 = next;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0);
      const y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      let path;
      if (frac >= 0.999) {
        path = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
      } else {
        path = `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${c}"><title>${esc(labels[i] || '')}: ${v} (${(frac * 100).toFixed(1)}%)</title></path>`;
      }
      const mid = (a0 + a1) / 2;
      const ly = cy + (r + 14) * Math.sin(mid);
      const textX = cx + (r + 24) * Math.cos(mid);
      const textA = Math.cos(mid) > 0 ? 'start' : 'end';
      angle = next;
      return `${path}<text x="${textX.toFixed(1)}" y="${ly.toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#333" text-anchor="${textA}" dominant-baseline="middle">${esc(labels[i] || '')} (${(frac * 100).toFixed(1)}%)</text>`;
    })
    .join('');
  const isDoughnut = opts.doughnut;
  const doughnutHole = isDoughnut ? `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#fff"/>
    ${opts.title ? `<text x="${w / 2}" y="18" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#222" font-weight="bold">${esc(opts.title)}</text>` : ''}
    ${slices}${doughnutHole}
  </svg>`;
}

// spec: { type, title, labels, series: [{name, values: [], color?, x?:[]}, ...] }
function chartSvgBuild(spec, { width = 720, height = 360 } = {}) {
  if (!spec || !spec.series) {
    throw new Error('chart-svg: spec.series required');
  }
  const labels = spec.labels || spec.series[0].values.map((_, i) => String(i + 1));
  const series = spec.series.map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    values: s.values || [],
    x: s.x,
    color: s.color || PALETTE[i % PALETTE.length],
  }));
  const t = (spec.type || 'bar').toLowerCase();
  if (t === 'bar' || t === 'column' || t === 'histogram') {
    return drawBar(width, height, labels, series, { title: spec.title });
  }
  if (t === 'line' || t === 'area') {
    return drawLine(width, height, labels, series, { title: spec.title, area: t === 'area' });
  }
  if (t === 'pie' || t === 'doughnut') {
    return drawPie(width, height, labels, series, { title: spec.title, doughnut: t === 'doughnut' });
  }
  if (t === 'scatter') {
    return drawScatter(width, height, labels, series, { title: spec.title });
  }
  throw new Error(`chart-svg: unknown type "${spec.type}"`);
}

// ---- base skill + registry ----

class Skill {
  constructor() {
    this.name = 'base';
    this.description = 'base skill, do not use directly';
    this.category = 'base';
    this.inputSchema = { type: 'object', properties: {} };
    this.outputKind = 'file'; // file | text | json
  }

  validate(input) {
    if (!input || typeof input !== 'object') {
      throw new Error(`skill ${this.name}: input must be an object`);
    }
    return input;
  }

  async run(_input, _ctx) {
    throw new Error(`skill ${this.name}: run() not implemented`);
  }

  // ask the model for a JSON spec matching `hint`. rewire onto ctx.engine.
  async deriveSpec(ctx, { goal, hint, format, retries = 2 }) {
    if (!ctx || !ctx.engine || typeof ctx.engine.generateJSON !== 'function') {
      throw new Error('deriveSpec: ctx.engine.generateJSON missing');
    }
    const sys = `You are a spec generator. The user will describe a goal; you respond ONLY with valid ${format || 'JSON'}. No prose, no fences.`;
    const prompt = `${sys}\n\n${hint || ''}\n\nGoal: ${goal}\n\nRespond with JSON.`;
    const model = ctx.config?.defaultModel || ctx.engine.defaultModel;
    return ctx.engine.generateJSON(prompt, { model });
  }

  // if specFromGoal is on, ask the model to fill in the spec; else just echo input
  async resolveSpec(ctx, input, hint) {
    if (input.specFromGoal && input.goal && ctx?.engine) {
      const derived = await this.deriveSpec(ctx, { goal: input.goal, format: 'JSON', hint });
      return { ...input, ...derived };
    }
    return input;
  }

  async ensureOut(dir) {
    if (!dir) throw new Error('skill: output dir required');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  // write a string artifact w/ the standard out-path/filename boilerplate
  async writeOut(input, ext, content, extra = {}) {
    const r = resolveOut({ outDir: input.outDir, filename: input.filename, ext });
    await this.ensureOut(r.dir);
    await fsp.writeFile(r.path, content, 'utf8');
    const stat = await fsp.stat(r.path);
    return { ok: true, path: r.path, filename: r.filename, bytes: stat.size, ...extra };
  }

  // resolve the outDir+filename pair without writing
  async planOut(input, ext) {
    const r = resolveOut({ outDir: input.outDir, filename: input.filename, ext });
    await this.ensureOut(r.dir);
    return r;
  }
}

class SkillRegistry {
  constructor() {
    this.skills = new Map();
  }

  register(skill) {
    if (!skill || !skill.name) throw new Error('skill registry: skill must have a name');
    this.skills.set(skill.name, skill);
    return skill;
  }

  get(name) {
    return this.skills.get(name);
  }

  list() {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      inputSchema: s.inputSchema,
      outputKind: s.outputKind,
    }));
  }

  // filename-based discovery. all built-ins are registered explicitly below,
  // so this is here for parity — drop extra .js files in a dir to extend.
  async discover(dir) {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.js')) continue;
      if (f === 'base.js' || f === 'index.js' || f === '_util.js' || f === 'skills.js') continue;
      const name = f.replace(/\.js$/, '');
      if (this.skills.has(name)) continue;
      try {
        const mod = await import(path.join(dir, f));
        const Klass = mod.default || mod;
        const inst = typeof Klass === 'function' ? new Klass() : Klass;
        if (inst && inst.name && typeof inst.run === 'function') this.register(inst);
      } catch {
        // skip a bad file, don't take the server down
      }
    }
    return this.list();
  }
}

// ---- built-in skills ----

class CsvSkill extends Skill {
  constructor() {
    super();
    this.name = 'csv';
    this.category = 'data';
    this.description = 'build clean .csv files from JSON data or derive a spec from a goal';
    this.outputKind = 'file';
    this.inputSchema = {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        outDir: { type: 'string' },
        delimiter: { type: 'string', description: 'csv delimiter, default ","' },
        newline: { type: 'string', description: 'csv newline, default "\\r\\n"' },
        rows: { type: 'array', description: 'array of objects' },
        columns: { type: 'array', description: 'ordered [{key,header}] list' },
        sortBy: { type: 'string', description: 'column key to sort by (asc)' },
        sortDesc: { type: 'boolean' },
        filter: { type: 'string', description: 'JS expression to keep row when truthy, e.g. "r.x > 5"' },
        specFromGoal: { type: 'boolean' },
        goal: { type: 'string' },
        schema: { type: 'array', description: 'for specFromGoal: ordered list of {key, header, hint}' },
        rowCount: { type: 'number', description: 'for specFromGoal: how many rows to generate' },
      },
    };
  }

  validate(input) {
    super.validate(input);
    if (!input.rows && !input.specFromGoal) {
      throw new Error('csv skill: need either "rows" array or "specFromGoal: true" + "goal"');
    }
    return input;
  }

  buildHint(input) {
    return `Produce a JSON object matching:
{
  "columns": [ { "key": "<row object key>", "header": "<display text>", "type": "<string|number|boolean|date>" } ],
  "rows": [ { "<key>": <value>, ... } ]
}
Goal: ${input.goal}
${input.schema ? `Schema hint: ${JSON.stringify(input.schema)}` : ''}
${input.rowCount ? `Row count: ${input.rowCount}` : 'Row count: between 20 and 100, real-looking data.'}
Return ONLY the JSON object. No prose, no fences.`;
  }

  async run(input, ctx = {}) {
    this.validate(input);
    const spec = await this.resolveSpec(ctx, input, this.buildHint(input));

    const { dir, path: outPath, filename: fname } = resolveOut({
      outDir: spec.outDir,
      filename: spec.filename,
      ext: 'csv',
    });
    await this.ensureOut(dir);

    let columns = spec.columns;
    let rows = Array.isArray(spec.rows) ? spec.rows.slice() : [];
    if (!columns || !columns.length) {
      const first = rows[0] || {};
      columns = Object.keys(first).map((k) => ({ key: k, header: k }));
    }
    if (spec.sortBy) {
      const k = spec.sortBy;
      const dir = spec.sortDesc ? -1 : 1;
      rows.sort((a, b) => {
        const av = a[k],
          bv = b[k];
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    if (spec.filter) {
      // safe expression filter — no Function/eval
      const fn = compileRowFilter(spec.filter);
      rows = rows.filter((r) => fn(r));
    }

    const data = rows.map((r) => {
      const out = {};
      for (const c of columns) {
        let v = r[c.key];
        if (v == null) v = '';
        out[c.header || c.key] = v;
      }
      return out;
    });

    // papaparse lazily so a missing install can't kill import
    let Papa;
    try {
      const mod = await import('papaparse');
      Papa = mod.default ?? mod;
    } catch {
      return { ok: false, error: 'dependency not installed: papaparse' };
    }
    const csv = Papa.unparse(data, {
      delimiter: spec.delimiter || ',',
      newline: spec.newline || '\r\n',
      header: true,
      quotes: true,
    });
    await fsp.writeFile(outPath, csv, 'utf8');
    const stat = await fsp.stat(outPath);
    return {
      ok: true,
      path: outPath,
      filename: fname,
      bytes: stat.size,
      rows: rows.length,
      columns: columns.map((c) => c.header || c.key),
    };
  }
}

const SPEC_HINT_MD = `Produce a JSON object matching:
{
  "filename": "<string>",
  "title": "<string>",
  "subtitle": "<string>",
  "author": "<string>",
  "sections": [
    {
      "heading": "<h1/h2 text>",
      "level": <1|2|3>,
      "body": "<markdown body for this section (paragraphs, lists, tables in markdown)>"
    }
  ],
  "citations": [ "<source 1>", "<source 2>" ]
}
Goal: derive a complete, professional report outline + filled-in body for this goal.
- each section body should be at least 2 paragraphs of substantive prose, real
  examples, or tables in markdown. Avoid lorem ipsum.
- citations should be plausible real-looking references.
Return ONLY the JSON object, no prose, no fences.`;

class MarkdownSkill extends Skill {
  constructor() {
    super();
    this.name = 'markdown';
    this.category = 'report';
    this.description = 'build long-form markdown reports w/ TOC, sections, citations';
    this.outputKind = 'file';
    this.inputSchema = {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        outDir: { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string' },
        sections: { type: 'array' },
        citations: { type: 'array' },
        specFromGoal: { type: 'boolean' },
        goal: { type: 'string' },
      },
    };
  }

  validate(input) {
    super.validate(input);
    if (!input.sections && !input.specFromGoal) {
      throw new Error('markdown skill: need either "sections" array or "specFromGoal: true" + "goal"');
    }
    return input;
  }

  async run(input, ctx = {}) {
    this.validate(input);
    const spec = await this.resolveSpec(ctx, input, SPEC_HINT_MD);

    const { dir, path: outPath, filename: fname } = resolveOut({
      outDir: spec.outDir,
      filename: spec.filename,
      ext: 'md',
    });
    await this.ensureOut(dir);

    const sections = spec.sections || [];
    const lines = [];
    lines.push('---');
    lines.push(`title: ${spec.title || 'Untitled'}`);
    if (spec.subtitle) lines.push(`subtitle: ${spec.subtitle}`);
    if (spec.author) lines.push(`author: ${spec.author}`);
    lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`generated_by: deepthink-mcp-server`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${spec.title || 'Report'}`);
    if (spec.subtitle) lines.push(`*${spec.subtitle}*`);
    lines.push('');

    if (sections.length) {
      const toc = sections
        .map((s) => {
          const lvl = Math.max(1, s.level || 2);
          const indent = '  '.repeat(lvl - 1);
          const slug = String(s.heading)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
          return `${indent}- [${s.heading}](#${slug})`;
        })
        .join('\n');
      lines.push('## Table of Contents');
      lines.push('');
      lines.push(toc);
      lines.push('');
    }

    for (const s of sections) {
      const lvl = Math.max(1, Math.min(6, s.level || 2));
      lines.push(`${'#'.repeat(lvl)} ${s.heading}`);
      lines.push('');
      if (s.body) {
        lines.push(s.body.trim());
        lines.push('');
      }
    }

    if (Array.isArray(spec.citations) && spec.citations.length) {
      lines.push('## References');
      lines.push('');
      spec.citations.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
      lines.push('');
    }

    await fsp.writeFile(outPath, lines.join('\n'), 'utf8');
    const stat = await fsp.stat(outPath);
    return {
      ok: true,
      path: outPath,
      filename: fname,
      bytes: stat.size,
      sections: sections.length,
      citations: (spec.citations || []).length,
    };
  }
}

class JsonSpecSkill extends Skill {
  constructor() {
    super();
    this.name = 'json-spec';
    this.category = 'data';
    this.description = 'derive a JSON array of N items matching a schema from a natural-language goal';
    this.outputKind = 'json';
    this.inputSchema = {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        schema: { type: 'array', description: 'array of {key, type, hint}' },
        count: { type: 'number', description: 'how many items (default 10)' },
        model: { type: 'string' },
        outFile: { type: 'string', description: 'optional file to write the result' },
        outDir: { type: 'string' },
      },
      required: ['goal'],
    };
  }

  validate(input) {
    super.validate(input);
    if (!input.goal) throw new Error('json-spec skill: "goal" required');
    if (input.count != null && (input.count < 1 || input.count > 500)) {
      throw new Error('json-spec skill: count must be 1..500');
    }
    return input;
  }

  async run(input, ctx = {}) {
    this.validate(input);
    const count = input.count || 10;
    const schema = input.schema || [
      { key: 'name', type: 'string', hint: 'a name' },
      { key: 'description', type: 'string', hint: 'a short description' },
    ];
    const hint = `Produce a JSON object of the form { "items": [ ... ] } where "items" is an array of ${count} objects.
Each object must match this schema:
${JSON.stringify(schema, null, 2)}

Goal: ${input.goal}

The data should be realistic, varied, and look like real data — not placeholder lorem ipsum.`;
    const res = await this.deriveSpec(ctx, { goal: input.goal, format: 'JSON', hint });
    // deriveSpec may return an array, {items:[...]}, or any object w/ an array prop
    let items;
    if (Array.isArray(res)) items = res;
    else if (res && Array.isArray(res.items)) items = res.items;
    else if (res && typeof res === 'object') {
      items = Object.values(res).find((v) => Array.isArray(v)) || [];
    } else {
      items = [];
    }

    if (input.outFile) {
      const outDir = input.outDir || REPORTS_DIR;
      await this.ensureOut(outDir);
      const fp = path.join(outDir, input.outFile);
      await fsp.writeFile(fp, JSON.stringify(items, null, 2), 'utf8');
      return { ok: true, count: items.length, path: fp, items };
    }
    return { ok: true, count: items.length, items };
  }
}

const SPEC_HINT_HTML = `Produce a JSON object matching:
{
  "filename": "<string>",
  "title": "<string>",
  "subtitle": "<string>",
  "author": "<string>",
  "theme": "<light|dark|slate>",
  "sections": [
    {
      "heading": "<string>",
      "body": "<html body, paragraphs/lists/tables allowed>",
      "chart": { "type": "<bar|line|pie|area|doughnut|scatter>", "title": "<string>", "labels": [...], "series": [{ "name": "...", "values": [...] }] }
    }
  ]
}
Goal: derive a complete, professional report.
- each section body should be substantive (2+ paragraphs of prose or a table)
- chart series values are arrays of numbers
Return ONLY the JSON object, no prose, no fences.`;

const THEMES = {
  light: { bg: '#ffffff', text: '#1a1a1a', accent: '#1F4E78', card: '#f8f9fa', border: '#dee2e6' },
  dark: { bg: '#0f1115', text: '#e6e6e6', accent: '#5cc8ff', card: '#1a1d24', border: '#2a2f3a' },
  slate: { bg: '#f5f7fa', text: '#1f2937', accent: '#2563eb', card: '#ffffff', border: '#e5e7eb' },
};

class HtmlReportSkill extends Skill {
  constructor() {
    super();
    this.name = 'html-report';
    this.category = 'report';
    this.description = 'build self-contained .html reports w/ inline svg charts';
    this.outputKind = 'file';
    this.inputSchema = {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        outDir: { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string' },
        theme: { type: 'string' },
        sections: { type: 'array' },
        specFromGoal: { type: 'boolean' },
        goal: { type: 'string' },
      },
    };
  }

  validate(input) {
    super.validate(input);
    if (!input.sections && !input.specFromGoal) {
      throw new Error('html-report skill: need "sections" or specFromGoal');
    }
    return input;
  }

  async run(input, ctx = {}) {
    this.validate(input);
    const spec = await this.resolveSpec(ctx, input, SPEC_HINT_HTML);
    const { dir, path: outPath, filename: fname } = resolveOut({
      outDir: spec.outDir,
      filename: spec.filename,
      ext: 'html',
    });
    await this.ensureOut(dir);

    const theme = THEMES[spec.theme] || THEMES.slate;
    const sections = spec.sections || [];
    const html = renderHtml({
      title: spec.title || 'Report',
      subtitle: spec.subtitle,
      author: spec.author,
      theme,
      sections,
    });

    await fsp.writeFile(outPath, html, 'utf8');
    const stat = await fsp.stat(outPath);
    return { ok: true, path: outPath, filename: fname, bytes: stat.size, sections: sections.length };
  }
}

function alignStyle(a) {
  if (a.startsWith(':') && a.endsWith(':')) return 'text-align:center';
  if (a.endsWith(':')) return 'text-align:right';
  return '';
}

function themeCss(theme) {
  return `
    :root { --bg: ${theme.bg}; --text: ${theme.text}; --accent: ${theme.accent}; --card: ${theme.card}; --border: ${theme.border}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
           background: var(--bg); color: var(--text); line-height: 1.55; }
    .wrap { max-width: 920px; margin: 0 auto; padding: 32px 24px 96px; }
    header { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 32px; }
    h1 { font-size: 36px; margin: 0 0 8px; color: var(--accent); letter-spacing: -0.5px; }
    .subtitle { font-size: 18px; color: #888; margin: 0 0 12px; }
    .meta { font-size: 13px; color: #888; }
    h2 { font-size: 24px; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); color: var(--accent); }
    h3 { font-size: 18px; margin: 24px 0 8px; color: var(--text); }
    p { margin: 0 0 14px; }
    ul, ol { padding-left: 22px; }
    li { margin-bottom: 6px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin: 16px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    th { background: var(--card); font-weight: 600; color: var(--accent); }
    code { background: var(--card); padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    pre { background: var(--card); border: 1px solid var(--border); padding: 14px; border-radius: 6px; overflow-x: auto; }
    .chart-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; }
    .chart-wrap svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
    footer { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: #888; text-align: center; }
  `;
}

function renderHtml({ title, subtitle, author, theme, sections }) {
  const sectionHtml = sections
    .map((s) => {
      const body = mdToHtml(s.body || '');
      let chart = '';
      if (s.chart && Array.isArray(s.chart.series) && s.chart.series.length) {
        chart = `<div class="chart-wrap">${chartSvgBuild(s.chart, { width: 720, height: 360 })}</div>`;
      }
      return `<section><h2>${esc(s.heading || 'Section')}</h2>${body}${chart}</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>${themeCss(theme)}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(title)}</h1>
    ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
    <p class="meta">${author ? `By ${esc(author)} · ` : ''}${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </header>
  ${sectionHtml}
  <footer>Generated by deepthink</footer>
</div>
</body>
</html>`;
}

// tiny markdown -> html. headings, bold, italic, code, lists, tables. not a full parser.
function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:-]+\|/.test(lines[i + 1])) {
      const headers = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      const aligns = lines[i + 1].split('|').map((c) => c.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(
          lines[i]
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean),
        );
        i++;
      }
      let t = '<table><thead><tr>';
      headers.forEach((h, j) => {
        t += `<th style="${alignStyle(aligns[j + 1] || '')}">${inline(h)}</th>`;
      });
      t += '</tr></thead><tbody>';
      rows.forEach((r) => {
        t += '<tr>';
        r.forEach((c, j) => {
          t += `<td style="${alignStyle(aligns[j + 1] || '')}">${inline(c)}</td>`;
        });
        t += '</tr>';
      });
      t += '</tbody></table>';
      out.push(t);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push(listBlock(lines, i, /^\s*[-*]\s+/, 'ul'));
      i = consumeList(lines, i, /^\s*[-*]\s+/);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push(listBlock(lines, i, /^\s*\d+\.\s+/, 'ol'));
      i = consumeList(lines, i, /^\s*\d+\.\s+/);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\|.*\|)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function consumeList(lines, i, rx) {
  while (i < lines.length && rx.test(lines[i])) i++;
  return i;
}

function listBlock(lines, i, rx, tag) {
  const items = [];
  while (i < lines.length && rx.test(lines[i])) {
    items.push(lines[i].replace(rx, ''));
    i++;
  }
  return `<${tag}>` + items.map((it) => `<li>${inline(it)}</li>`).join('') + `</${tag}>`;
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

const SPEC_HINT_EXCEL = `Produce a JSON object matching this schema exactly:
{
  "filename": "<string>",
  "title": "<string>",
  "author": "<string>",
  "sheets": [
    {
      "name": "<sheet name>",
      "title": "<optional title row>",
      "tabColor": "<hex w/o #, optional>",
      "freeze": "<cell ref like A2 or null>",
      "columns": [
        {
          "key": "<row-object-key>",
          "header": "<display text>",
          "width": <number>,
          "format": "<excel number format like '#,##0.00' or '$#,##0' or '0.00%' or null>",
          "style": "<header|body|total|accent|null>",
          "formula": "<optional formula; tokens {row} -> row number, {col} -> column letter>",
          "total": "<true|'sum'|'avg'|'count'|'min'|'max'|false>",
          "totalFormula": "<optional custom total formula string>"
        }
      ],
      "rows": [ { "<key>": <value>, ... } ],
      "totalRow": <true|false>,
      "totalLabel": "<string, default 'Total'>",
      "totalKey": "<column key for the total label>",
      "banding": <true|false>,
      "conditionalFormat": {
        "column": "<key>",
        "type": "<colorScale|dataBar|iconSet|expression>",
        "options": { ... } ,
        "formula": "<expression formula when type=expression>",
        "style": { ... override style for expression ... }
      },
      "chart": {
        "type": "<bar|line|pie|area|doughnut|scatter>",
        "title": "<string>",
        "position": "<cell ref like H2>",
        "width": <px>,
        "height": <px>,
        "labels": ["<x axis category>"],
        "series": [ { "name": "<legend>", "values": [<numbers>], "x": [<numbers, only for scatter>] } ],
        "labelColumn": "<column key for labels>",
        "valueColumns": ["<column key>", "<column key>", ...]
      }
    }
  ]
}
Return ONLY the JSON object, no prose, no fences.`;

const TOTAL_OPS = { SUM: 1, AVG: 1, AVERAGE: 1, COUNT: 1, MIN: 1, MAX: 1 };
const isNumericFormat = (f) => f && /[0#]/.test(f);

const HEADER_FILL = 'FF1F4E78';
const HEADER_FONT = 'FFFFFFFF';
const TOTAL_FILL = 'FFD9E1F2';
const BAND_FILL = 'FFF2F2F2';

class ExcelSkill extends Skill {
  constructor() {
    super();
    this.name = 'excel';
    this.category = 'spreadsheet';
    this.description = 'build multi-sheet .xlsx reports w/ formulas, charts, conditional formats, totals';
    this.outputKind = 'file';
    this.inputSchema = {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        outDir: { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string' },
        sheets: { type: 'array' },
        namedRanges: { type: 'object' },
        specFromGoal: { type: 'boolean' },
        goal: { type: 'string' },
      },
      required: ['sheets'],
    };
  }

  validate(input) {
    super.validate(input);
    // when specFromGoal is true the model will fill in sheets — don't require them upfront
    if (input.specFromGoal) return input;
    if (!input.sheets || !Array.isArray(input.sheets) || input.sheets.length === 0) {
      throw new Error('excel skill: "sheets" array required');
    }
    return input;
  }

  async run(input, ctx = {}) {
    this.validate(input);
    const spec = await this.resolveSpec(ctx, input, SPEC_HINT_EXCEL);

    const { dir, path: outPath, filename: fname } = resolveOut({
      outDir: spec.outDir,
      filename: spec.filename,
      ext: 'xlsx',
    });
    await this.ensureOut(dir);

    // exceljs + sharp loaded lazily — both heavy native deps
    let ExcelJS, sharp;
    try {
      ExcelJS = (await import('exceljs')).default;
    } catch {
      return { ok: false, error: 'dependency not installed: exceljs' };
    }
    try {
      sharp = (await import('sharp')).default;
    } catch {
      return { ok: false, error: 'dependency not installed: sharp' };
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = spec.author || 'deepthink';
    wb.created = new Date();
    wb.modified = new Date();
    if (spec.title) {
      wb.title = spec.title;
      wb.subject = spec.title;
    }

    for (const sheetSpec of spec.sheets) {
      await this._buildSheet(wb, sheetSpec, ctx, sharp);
    }

    if (spec.namedRanges && typeof spec.namedRanges === 'object') {
      for (const [name, ref] of Object.entries(spec.namedRanges)) {
        try {
          wb.definedNames.add(ref, name);
        } catch {
          /* skip bad refs */
        }
      }
    }

    await wb.xlsx.writeFile(outPath);
    const stat = await fsp.stat(outPath);
    return {
      ok: true,
      path: outPath,
      filename: fname,
      bytes: stat.size,
      sheets: spec.sheets.length,
      title: spec.title || null,
    };
  }

  async _buildSheet(wb, spec, ctx, sharp) {
    const ws = wb.addWorksheet(spec.name || 'Sheet', {
      properties: { defaultRowHeight: 16, tabColor: spec.tabColor || undefined },
    });

    // freeze panes: A2 freezes top row, B2 freezes top row + col A, etc
    if (spec.freeze) {
      const m = /([A-Z]+)(\d+)/.exec(spec.freeze);
      if (m) {
        ws.views = [
          {
            state: 'frozen',
            xSplit: colLetterToNum(m[1]) - 1,
            ySplit: Number(m[2]) - 1,
            activeCell: spec.freeze,
          },
        ];
      }
    }

    let dataStartRow = 1;
    if (spec.title) {
      ws.getRow(1).getCell(1).value = spec.title;
      ws.getRow(1).font = { size: 16, bold: true, color: { argb: 'FF1F4E78' } };
      ws.getRow(1).height = 28;
      dataStartRow = 2;
    }

    const cols = (spec.columns || []).map((c) => ({ key: c.key, width: c.width || 16 }));
    ws.columns = cols;

    const headerRow = ws.getRow(dataStartRow);
    spec.columns.forEach((c, j) => {
      headerRow.getCell(j + 1).value = c.header || c.key;
    });
    headerRow.font = { bold: true, color: { argb: HEADER_FONT } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 22;
    headerRow.commit();

    const rows = Array.isArray(spec.rows) ? spec.rows : [];
    const bodyStart = dataStartRow + 1;
    rows.forEach((r, i) => {
      const row = ws.getRow(bodyStart + i);
      if (spec.banding !== false && i % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } };
      }
      cols.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        const v = r[c.key];
        if (v !== undefined && v !== null) cell.value = v;
        if (c.style === 'body') cell.alignment = { vertical: 'middle' };
        if (c.style === 'accent') cell.font = { bold: true, color: { argb: 'FF1F4E78' } };
      });
      row.commit();
    });

    // formulas + number formats. resolve each column's letter once
    const colLetters = cols.map((_, j) => numToColLetter(j + 1));
    for (let i = 0; i < rows.length; i++) {
      const row = ws.getRow(bodyStart + i);
      spec.columns.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        if (c.formula) {
          const f = c.formula.replace(/\{row\}/g, String(bodyStart + i)).replace(/\{col\}/g, colLetters[j]);
          cell.value = { formula: f };
        }
        if (c.format) cell.numFmt = c.format;
      });
    }

    const lastRow = bodyStart + rows.length - 1;
    if (spec.totalRow && rows.length > 0) this._addTotalRow(ws, spec, colLetters, bodyStart, lastRow);

    if (spec.conditionalFormat) this._addConditionalFormat(ws, spec, colLetters, bodyStart, lastRow);
    if (spec.chart) {
      try {
        await this._addChart(wb, ws, spec.chart, spec.columns, rows, bodyStart, sharp);
      } catch (e) {
        this._emit(ctx, 'chart-failed', { sheet: spec.name, error: e.message });
      }
    }
  }

  // route a log line through whatever the runtime gives us
  _emit(ctx, channel, data) {
    const entry = { channel, data, ts: Date.now() };
    if (typeof ctx.pushLog === 'function') ctx.pushLog(entry);
    else if (Array.isArray(ctx.eventLog)) ctx.eventLog.push(entry);
  }

  // pick the label column: totalKey, then style:total, then first non-numeric, then col A
  _pickTotalLabelCol(spec) {
    const cols = spec.columns;
    if (spec.totalKey) {
      const i = cols.findIndex((c) => c.key === spec.totalKey);
      if (i >= 0) return i;
    }
    const styled = cols.findIndex((c) => c.style === 'total');
    if (styled >= 0) return styled;
    const nonNum = cols.findIndex((c) => !isNumericFormat(c.format));
    return nonNum >= 0 ? nonNum : 0;
  }

  _addTotalRow(ws, spec, colLetters, bodyStart, lastRow) {
    // total sits one row past the last body row
    const row = ws.getRow(lastRow + 1);
    const cols = spec.columns;
    const labelColIdx = this._pickTotalLabelCol(spec);
    row.getCell(labelColIdx + 1).value = spec.totalLabel || 'Total';
    cols.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      // sum if explicit total, or numeric col w/ no opt-out
      const wantsTotal = c.total === true || typeof c.total === 'string';
      const shouldSum = c.totalFormula || wantsTotal || (isNumericFormat(c.format) && c.total !== false);
      if (j !== labelColIdx && c.totalFormula) {
        cell.value = { formula: c.totalFormula };
      } else if (j !== labelColIdx && shouldSum) {
        const op = typeof c.total === 'string' ? c.total.toUpperCase() : 'SUM';
        if (TOTAL_OPS[op]) {
          const fn = op === 'AVG' ? 'AVERAGE' : op;
          cell.value = { formula: `=${fn}(${colLetters[j]}${bodyStart}:${colLetters[j]}${lastRow})` };
        }
      }
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
      if (c.format && j !== labelColIdx) cell.numFmt = c.format;
    });
    row.commit();
  }

  _addConditionalFormat(ws, spec, colLetters, bodyStart, lastRow) {
    const cf = spec.conditionalFormat;
    const colIdx = spec.columns.findIndex((c) => c.key === cf.column);
    if (colIdx < 0) return;
    const range = `${colLetters[colIdx]}${bodyStart}:${colLetters[colIdx]}${lastRow}`;
    if (cf.type === 'colorScale') {
      ws.addConditionalFormatting({
        ref: range,
        rules: [
          {
            type: 'colorScale',
            cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
            color: cf.options || [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }],
          },
        ],
      });
    } else if (cf.type === 'dataBar') {
      ws.addConditionalFormatting({
        ref: range,
        rules: [
          {
            type: 'dataBar',
            cfvo: [{ type: 'min' }, { type: 'max' }],
            color: (cf.options && cf.options.color) || { argb: 'FF638EC6' },
            gradient: true,
          },
        ],
      });
    } else if (cf.type === 'iconSet') {
      ws.addConditionalFormatting({
        ref: range,
        rules: [
          {
            type: 'iconSet',
            iconSet: (cf.options && cf.options.iconSet) || '3TrafficLights1',
            cfvo: [
              { type: 'percent', value: 0 },
              { type: 'percent', value: 33 },
              { type: 'percent', value: 67 },
            ],
          },
        ],
      });
    } else if (cf.type === 'expression' && cf.formula) {
      ws.addConditionalFormatting({
        ref: range,
        rules: [
          {
            type: 'expression',
            formulae: [cf.formula],
            style: cf.style || { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } },
          },
        ],
      });
    }
  }

  async _addChart(wb, ws, chart, cols, rows, _bodyStart, sharp) {
    const w = chart.width || 720;
    const h = chart.height || 360;
    const series = this._resolveSeries(chart, cols, rows);
    const labels = this._resolveLabels(chart, cols, rows) || series[0].values.map((_, i) => String(i + 1));

    const svg = chartSvgBuild({ type: chart.type, title: chart.title, labels, series }, { width: w, height: h });
    // svg -> png via sharp (works headless, no canvas)
    const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    const imageId = wb.addImage({ buffer: png, extension: 'png' });
    const pos = chart.position || 'H2';
    const m = /([A-Z]+)(\d+)/.exec(pos);
    const anchor = m
      ? { tl: { col: colLetterToNum(m[1]) - 1, row: Number(m[2]) - 1 }, ext: { width: w, height: h } }
      : { tl: { col: 7, row: 1 }, ext: { width: w, height: h } };
    ws.addImage(imageId, anchor);
    return { ok: true, imageId, bytes: png.length };
  }

  _resolveSeries(chart, cols, rows) {
    if (Array.isArray(chart.series) && chart.series.length) return chart.series;
    if (!Array.isArray(chart.valueColumns) || !chart.valueColumns.length) {
      throw new Error('chart: no series resolved (need chart.series or chart.valueColumns)');
    }
    return chart.valueColumns.map((vk) => {
      const c = cols.find((cc) => cc.key === vk);
      return { name: c ? c.header || c.key : vk, values: rows.map((r) => Number(r[vk] || 0)) };
    });
  }

  _resolveLabels(chart, cols, rows) {
    if (Array.isArray(chart.labels) && chart.labels.length) return chart.labels;
    if (chart.labelColumn) {
      const idx = cols.findIndex((c) => c.key === chart.labelColumn);
      if (idx >= 0) {
        return rows.map((r) => {
          const v = r[chart.labelColumn];
          return v == null ? '' : String(v);
        });
      }
    }
    return null;
  }
}

// ---- registry + exported tools ----

const registry = new SkillRegistry();
registry.register(new CsvSkill());
registry.register(new MarkdownSkill());
registry.register(new JsonSpecSkill());
registry.register(new HtmlReportSkill());
registry.register(new ExcelSkill());

// internal registry access for cross-tool callers that hold `ctx`
export function getRegistry() {
  return registry;
}

// list the built-in skills
async function listSkills(args, ctx) {
  const skills = registry.list().map((s) => ({
    name: s.name,
    description: s.description,
    category: s.category,
  }));
  return { ok: true, skills };
}

// run one skill by name, params merged onto args
async function runSkill(args, ctx) {
  const { name, ...params } = args || {};
  const skill = registry.get(name);
  if (!skill) {
    return { ok: false, error: `unknown skill: ${name}` };
  }
  try {
    return await skill.run({ ...params }, ctx || {});
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export default {
  deepthink_list_skills: listSkills,
  deepthink_run_skill: runSkill,
};
