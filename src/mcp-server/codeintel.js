// src/mcp-server/codeintel.js
// codebase search, dependency audit, and lightweight AST-ish analysis.
// all raw-text based, no external parsers, so it runs cheap across mixed repos.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

// recursive walker, honors ignores set (default + caller)
function* walk(dir, { ignores = DEFAULT_IGNORES, maxDepth = 12, _depth = 0 } = {}) {
  if (_depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (ignores.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p, { ignores, maxDepth, _depth: _depth + 1 });
    } else if (e.isFile()) {
      yield p;
    }
  }
}

// ripgrep-style search. up to `limit` hits with line numbers + trimmed text.
function searchCodebase({ root, query, regex = false, caseSensitive = false, filePattern, limit = 200 }) {
  const re = regex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : null;
  const reFile = filePattern ? new RegExp(filePattern) : null;
  const out = [];
  for (const file of walk(root)) {
    if (reFile && !reFile.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let hit = false;
      if (re) {
        re.lastIndex = 0;
        hit = re.test(line);
      } else if (caseSensitive) hit = line.includes(query);
      else hit = line.toLowerCase().includes(query.toLowerCase());
      if (hit) {
        out.push({
          file: path.relative(root, file).replace(/\\/g, '/'),
          line: i + 1,
          text: line.trim().slice(0, 400),
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// find files by name pattern. glob-ish, `*` and `**`.
function findFiles({ root, namePattern, limit = 200 }) {
  const re = new RegExp('^' + namePattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  const out = [];
  for (const file of walk(root)) {
    const base = path.basename(file);
    if (re.test(base) || re.test(file.replace(/\\/g, '/'))) {
      out.push({ path: path.relative(root, file).replace(/\\/g, '/') });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// map of which files import/require which modules — quick dep sketch.
function buildImportMap({ root, exts = new Set(['.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx']) } = {}) {
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importRe = /import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const map = {};
  for (const file of walk(root)) {
    const ext = path.extname(file);
    if (!exts.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const imports = new Set();
    for (const m of text.matchAll(requireRe)) imports.add(m[1]);
    for (const m of text.matchAll(importRe)) imports.add(m[1]);
    if (imports.size > 0) map[rel] = [...imports];
  }
  return map;
}

// parse package.json, list deps, mark which are present in node_modules.
function auditPackageJson({ root }) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, error: 'package.json not found' };
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const installed = [];
  const missing = [];
  const nm = path.join(root, 'node_modules');
  for (const [name, ver] of Object.entries(all)) {
    const depPath = path.join(nm, name);
    if (fs.existsSync(depPath) || fs.existsSync(path.join(nm, ...name.split('/')))) {
      installed.push({ name, version: ver });
    } else {
      missing.push({ name, version: ver });
    }
  }
  return {
    ok: true,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    scripts: pkg.scripts || {},
    totalDeps: Object.keys(all).length,
    installed: installed.length,
    missing,
    engines: pkg.engines || null,
    license: pkg.license || null,
  };
}

// light function/arrow detection for js-ish files. approximate line range
// of every named fn — enough for "list functions" without a real parser.
function listFunctions({ file }) {
  if (!fs.existsSync(file)) return { ok: false, error: 'file not found' };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const fns = [];
  const patterns = [
    /^\s*function\s+(\w+)\s*\(/,
    /^\s*async\s+function\s+(\w+)\s*\(/,
    /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/,
    /^\s*(\w+)\s*\([^)]*\)\s*\{/,
    /^\s*(\w+)\s*:\s*(?:async\s+)?function/,
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = lines[i].match(p);
      if (m && m[1]) {
        fns.push({ name: m[1], line: i + 1 });
        break;
      }
    }
  }
  return { ok: true, file, count: fns.length, functions: fns };
}

// project skeleton: file counts by ext, total LOC, top dirs. cheap overview.
function projectOverview({ root, limit = 20 }) {
  const byExt = {};
  const byDir = {};
  let total = 0;
  let loc = 0;
  for (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase() || '(none)';
    byExt[ext] = (byExt[ext] || 0) + 1;
    const dir = path.relative(root, path.dirname(file)).replace(/\\/g, '/') || '.';
    byDir[dir] = (byDir[dir] || 0) + 1;
    total++;
    try {
      const text = fs.readFileSync(file, 'utf8');
      loc += text.split(/\r?\n/).length;
    } catch {
      // binary, skip
    }
  }
  const topExt = Object.entries(byExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const topDir = Object.entries(byDir)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return { ok: true, totalFiles: total, totalLoc: loc, byExt: topExt, byDir: topDir, root };
}

// arg validation helpers — each tool declares a spec and we coerce a root
// to cwd when missing. keeps the wrappers tiny.
function reqRoot(args) {
  const root = typeof args.root === 'string' && args.root ? args.root : process.cwd();
  return { ...args, root };
}

function fail(args, name) {
  return { ok: false, error: `missing or invalid arg: ${name}` };
}

// each tool is (args, ctx) => {ok:true,...} | {ok:false,error}
export default {
  async deepthink_search_code(args, _ctx) {
    if (typeof args.query !== 'string' || !args.query) return fail(args, 'query');
    const a = reqRoot(args);
    try {
      return { ok: true, matches: searchCodebase(a) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async deepthink_find_files(args, _ctx) {
    if (typeof args.namePattern !== 'string' || !args.namePattern) return fail(args, 'namePattern');
    const a = reqRoot(args);
    try {
      return { ok: true, files: findFiles(a) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async deepthink_project_overview(args, _ctx) {
    const a = reqRoot(args);
    try {
      return projectOverview(a);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async deepthink_import_map(args, _ctx) {
    const a = reqRoot(args);
    try {
      return { ok: true, imports: buildImportMap(a) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async deepthink_list_functions(args, _ctx) {
    if (typeof args.file !== 'string' || !args.file) return fail(args, 'file');
    try {
      return listFunctions(args);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async deepthink_audit_deps(args, _ctx) {
    const a = reqRoot(args);
    try {
      return auditPackageJson(a);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
