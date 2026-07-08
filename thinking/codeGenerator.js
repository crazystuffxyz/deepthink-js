// thinking/codeGenerator.js
'use strict';

import { exec, spawn } from 'child_process';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { stripCodeFences } from './dataTypes.js';
import { getFetchResults, getSearchResults } from '../internet/interactWithInternet.js';

const sandbox = 20_000;
const tmpSuffix = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

const file = `\
OUTPUT FORMAT — MANDATORY. Your output will be parsed by a machine. Deviate from this format and your code will not run.
To output a complete file:
### FILE: filename.ext
\`\`\`language
[complete file contents — no placeholders, no "// ... rest of code", no truncation]
\`\`\`
To patch only specific lines of an existing file:
### PATCH: filename.ext
---FIND---
[exact original lines to locate — must match character-for-character]
---REPLACE---
[replacement lines]
---END---
STRICT RULES:
1. "### FILE:" and "### PATCH:" headers must be on their own lines, no leading spaces.
2. The filename must be exact — correct extension, no spaces, matching what was previously defined.
3. Every code block must start with a language tag (js, python, json, etc).
4. Output COMPLETE file contents — never use "// TODO", "# ...", "// rest of code here" or any placeholder.
5. Do NOT wrap output in any outer code fence or prose block.
6. Do NOT output anything outside of ### FILE or ### PATCH blocks except a single line of brief context if needed.
7. NEVER use external image URLs — always use inline SVGs for all icons and graphics.
8. NEVER use base64-encoded images without code execution to generate them — use SVG only.
9. All href/src attributes for internal resources must use relative paths only.`;

const math = [
  'brute_force', 'dynamic_programming', 'recursion', 'divide_and_conquer',
  'greedy_algorithms', 'numerical_methods', 'monte_carlo_simulation', 'simulated_annealing',
  'group_theory', 'ring_theory', 'field_theory', 'galois_theory',
  'linear_algebra', 'multilinear_algebra', 'homological_algebra', 'commutative_algebra',
  'noncommutative_algebra', 'representation_theory', 'lie_algebras', 'boolean_algebra',
  'universal_algebra', 'module_theory', 'lattice_theory', 'tensor_algebra',
  'real_analysis', 'complex_analysis', 'functional_analysis', 'harmonic_analysis',
  'measure_theory', 'integration_theory', 'differentiation', 'limits_and_asymptotics',
  'ordinary_differential_equations', 'partial_differential_equations', 'calculus_of_variations',
  'stochastic_calculus', 'non_standard_analysis', 'convex_analysis', 'p_adic_analysis',
  'fourier_analysis', 'operator_theory', 'spectral_theory', 'fundamental_inequalities_of_real_analysis',
  'ergodic_theory', 'fractal_analysis', 'euclidean_geometry', 'non_euclidean_geometry',
  'projective_geometry', 'algebraic_geometry', 'differential_geometry', 'discrete_geometry',
  'computational_geometry', 'arithmetic_geometry', 'symplectic_geometry', 'riemannian_geometry',
  'fano_planes', 'finite_geometry', 'information_geometry', 'conformal_geometry', 'tropical_geometry',
  'point_set_topology', 'algebraic_topology', 'differential_topology', 'geometric_topology',
  'knot_theory', 'homotopy_theory', 'homology_theory', 'low_dimensional_topology', 'network_topology',
  'number_theory', 'analytic_number_theory', 'algebraic_number_theory', 'diophantine_analysis',
  'prime_number_theory', 'modular_arithmetic', 'elliptic_curves', 'class_field_theory',
  'probabilistic_number_theory', 'computational_number_theory', 'transcendental_number_theory',
  'combinatorics', 'graph_theory', 'generating_functions', 'inclusion_exclusion',
  'ramsey_theory', 'enumerative_combinatorics', 'extremal_combinatorics', 'algebraic_combinatorics',
  'matroid_theory', 'design_theory', 'coding_theory', 'hypergraph_theory', 'poset_theory',
  'set_theory', 'model_theory', 'proof_theory', 'recursion_theory',
  'computability_theory', 'type_theory', 'automata_theory', 'category_theory',
  'topos_theory', 'higher_category_theory', 'descriptive_set_theory',
  'probability_theory', 'statistics', 'game_theory', 'optimization',
  'linear_programming', 'nonlinear_programming', 'control_theory', 'information_theory',
  'cryptography', 'dynamical_systems', 'chaos_theory', 'queueing_theory',
  'operations_research', 'mathematical_physics', 'quantum_computing', 'tensor_networks',
  'markov_chains', 'stochastic_processes', 'combinatorial_game_theory', 'fluid_dynamics',
  'string_topology', 'quantum_field_theory_formulations',
];

function isPythonAvailable() {
  for (const bin of ['python3', 'python']) {
    try {
      execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
      return bin;
    } catch {}
  }
  return null;
}
const PYTHON_BIN = isPythonAvailable();

function compareResults(a, b) {
  const norm = s => {
    let t = String(s ?? '')
      .trim()
      .replace(/^(?:Integer|Float)\((.+)\)$/, '$1')
      .trim();
    const frac = t.match(/^(-?\d+)\/(-?\d+)$/);
    if (frac) return Number(frac[1]) / Number(frac[2]);
    const n = Number(t.replace(/[$,%\s]/g, ''));
    return isNaN(n) ? t.toLowerCase() : n;
  };
  const na = norm(a), nb = norm(b);
  if (typeof na === 'number' && typeof nb === 'number')
    return Math.abs(na - nb) / Math.max(Math.abs(na), Math.abs(nb), 1) < 1e-9;
  return na === nb;
}

function sympyEquality(a, b) {
  if (!PYTHON_BIN) return Promise.resolve(null);
  const checker = `
from sympy import sympify, simplify
try:
    print("EQUAL" if simplify(sympify(${JSON.stringify(String(a))}) - sympify(${JSON.stringify(String(b))})) == 0 else "NOTEQUAL")
except:
    print("ERROR")
`;
  return new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), `dt_sympy_${tmpSuffix()}.py`);
    fs.writeFileSync(tmp, checker, 'utf-8');
    exec(`${PYTHON_BIN} "${tmp}"`, { timeout: 8000 }, (_, stdout) => {
      fs.unlink(tmp, () => {});
      const r = (stdout || '').trim();
      resolve(r === 'EQUAL' ? true : r === 'NOTEQUAL' ? false : null);
    });
  });
}

function runJSSandbox(code) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `dt_run_${tmpSuffix()}.js`);
    const BLOCKED = "new Set(['child_process','fs','net','crypto','vm','inspector'])";
    const wrapper =
      `'use strict';\nconst _r=require;\nconst BL=${BLOCKED};\n` +
      `globalThis.require=(m)=>{if(BL.has(m))throw new Error('"'+m+'" blocked');return _r(m);};\n` +
      `(async()=>{try{\n${code}\n}catch(e){process.stderr.write(e.message+'\\n');process.exit(1);}})();`;
    fs.writeFileSync(tmp, wrapper, 'utf-8');
    let out = '', err = '';
    const proc = spawn(process.execPath, [tmp], { env: { PATH: process.env.PATH } });
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`JS timeout after ${sandbox / 1000}s`));
    }, sandbox);
    proc.on('close', code => {
      clearTimeout(t);
      fs.unlink(tmp, () => {});
      code !== 0 ? reject(new Error(err.trim() || `Exit ${code}`)) : resolve(out.trim());
    });
  });
}

function runPythonSandbox(code) {
  if (!PYTHON_BIN) return Promise.reject(new Error('Python not installed'));
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `dt_run_${tmpSuffix()}.py`);
    const wrapper = `
import builtins as _b, os as _o, sys as _s
_oi = _b.__import__
_BL = frozenset(['subprocess','ctypes','multiprocessing','importlib','sys','os','shutil','requests','socket'])
def _safe_import(n,*a,**k):
    if n.split('.')[0] in _BL: raise ImportError(f"'{n}' blocked")
    return _oi(n,*a,**k)
_b.__import__ = _safe_import
_b.eval = _b.exec = lambda *a,**k: print("EVAL/EXEC BLOCKED")
_o.system = _o.popen = lambda *a,**k: print("OS EXECUTION BLOCKED")
${code}
`;
    fs.writeFileSync(tmp, wrapper, 'utf-8');
    let out = '', err = '';
    const proc = spawn(PYTHON_BIN, ['-I', tmp], { env: { PATH: process.env.PATH } });
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Python timeout after ${sandbox / 1000}s`));
    }, sandbox);
    proc.on('close', code => {
      clearTimeout(t);
      fs.unlink(tmp, () => {});
      code !== 0 ? reject(new Error((err || `Exit ${code}`).trim())) : resolve(out.trim());
    });
  });
}

function checkSyntaxAST(filePath) {
  try {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
      execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    } else if (filePath.endsWith('.py') && PYTHON_BIN) {
      execSync(`${PYTHON_BIN} -m py_compile "${filePath}"`, { stdio: 'pipe' });
    }
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.stderr ? e.stderr.toString() : e.message };
  }
}

function parseFilesFromResponse(content) {
  const files = {};
  const primaryRegex =
    /^###\s+FILE:\s+([a-zA-Z0-9_./@-][a-zA-Z0-9_./@\- ]*?)\s*$\s*```[a-z]*\n([\s\S]*?)```/gm;
  let match;
  while ((match = primaryRegex.exec(content)) !== null) {
    const fname = match[1].trim();
    if (fname) files[fname] = match[2];
  }
  if (Object.keys(files).length > 0) return files;
  const fallbackA = /```(?:\w+)?\n(?:\/\/\s*|#\s*|---\s*)([a-zA-Z0-9_.-]+)\n([\s\S]*?)```/g;
  while ((match = fallbackA.exec(content)) !== null) {
    const fname = match[1].trim();
    if (fname && /\.[a-z]{1,6}$/.test(fname)) files[fname] = match[2];
  }
  if (Object.keys(files).length > 0) return files;
  const fallbackB = /```([a-zA-Z0-9_.-]+\.[a-z]{1,6})\n([\s\S]*?)```/g;
  while ((match = fallbackB.exec(content)) !== null) {
    files[match[1].trim()] = match[2];
  }
  return files;
}

function applyPatchBlocks(content, files) {
  const patchRegex =
    /^###\s+PATCH:\s+([a-zA-Z0-9_./@-][a-zA-Z0-9_./@\- ]*?)\s*$\s*---FIND---\s*\n([\s\S]*?)\n---REPLACE---\s*\n([\s\S]*?)\n---END---/gm;
  let match;
  while ((match = patchRegex.exec(content)) !== null) {
    const fname = match[1].trim();
    const findBlock = match[2];
    const replBlock = match[3];
    if (files[fname] && files[fname].includes(findBlock)) {
      files[fname] = files[fname].replace(findBlock, replBlock);
      console.log(`\x1b[36m[PATCH] Applied patch to ${fname}\x1b[0m`);
    } else if (files[fname]) {
      const trimFind = findBlock.trim();
      if (files[fname].includes(trimFind)) {
        files[fname] = files[fname].replace(trimFind, replBlock.trim());
        console.log(`\x1b[36m[PATCH] Applied trimmed patch to ${fname}\x1b[0m`);
      } else {
        console.warn(`\x1b[33m[PATCH] FIND block not matched in ${fname} — skipping patch\x1b[0m`);
      }
    }
  }
  const legacyRegex = /<<<SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>REPLACE\s+(\S+)/g;
  while ((match = legacyRegex.exec(content)) !== null) {
    const [, searchBlock, replaceBlock, fname] = match;
    if (files[fname] && files[fname].includes(searchBlock.trim())) {
      files[fname] = files[fname].replace(searchBlock.trim(), replaceBlock.trim());
      console.log(`\x1b[36m[PATCH] Applied legacy patch to ${fname}\x1b[0m`);
    }
  }
  return files;
}

function sanitizeBuildCmd(cmd, projectDir) {
  if (!cmd) return cmd;
  const pipMatch = cmd.match(/pip\d*\s+install\s+-r\s+(\S+)/i);
  if (pipMatch) {
    const reqFile = path.join(projectDir, pipMatch[1]);
    if (!fs.existsSync(reqFile)) return '';
  }
  return cmd;
}

function detectExternalImages(files) {
  const issues = [];
  const externalImgRe = /src=["']https?:\/\/[^"']+\.(png|jpg|jpeg|gif|webp|ico|bmp)["']/gi;
  const externalBgRe = /url\(["']?https?:\/\/[^"')]+\.(png|jpg|jpeg|gif|webp|ico|bmp)["']?\)/gi;
  const base64Re = /src=["']data:image\/(png|jpg|jpeg|gif|webp);base64,[^"']{50,}["']/gi;
  for (const [fname, content] of Object.entries(files)) {
    let m;
    while ((m = externalImgRe.exec(content)) !== null)
      issues.push({ file: fname, type: 'external_img_tag', match: m[0] });
    while ((m = externalBgRe.exec(content)) !== null)
      issues.push({ file: fname, type: 'external_bg_url', match: m[0] });
    while ((m = base64Re.exec(content)) !== null)
      issues.push({ file: fname, type: 'base64_image', match: m[0].slice(0, 80) + '...' });
  }
  return issues;
}

function detectBrokenLinks(files) {
  const issues = [];
  const hrefRe = /href=["']([^"'#?]+)["']/gi;
  const srcRe = /src=["']([^"']+)["']/gi;
  const allFileNames = new Set(Object.keys(files).map(f => path.basename(f)));
  for (const [fname, content] of Object.entries(files)) {
    if (!fname.endsWith('.html') && !fname.endsWith('.css') && !fname.endsWith('.js')) continue;
    let m;
    while ((m = hrefRe.exec(content)) !== null) {
      const href = m[1];
      if (href.startsWith('http') || href.startsWith('mailto') || href.startsWith('#')) continue;
      const base = path.basename(href);
      if (base && !allFileNames.has(base) && !href.startsWith('/api/'))
        issues.push({ file: fname, type: 'broken_href', ref: href });
    }
    while ((m = srcRe.exec(content)) !== null) {
      const src = m[1];
      if (src.startsWith('http') || src.startsWith('data:')) continue;
      const base = path.basename(src);
      if (base && base.match(/\.(png|jpg|jpeg|gif|webp|ico|bmp)$/i))
        issues.push({ file: fname, type: 'external_or_missing_img_src', ref: src });
    }
  }
  return issues;
}

async function fetchPackageDocumentation(callChat, packageNames, opts = {}) {
  if (!packageNames || packageNames.length === 0) return {};
  console.log(`\x1b[36m[PKG DOCS] Fetching documentation for ${packageNames.length} packages: ${packageNames.join(', ')}\x1b[0m`);
  const docs = {};
  for (const pkg of packageNames) {
    const npmUrl = `https://www.npmjs.com/package/${pkg}`;
    let docText = '';
    let searchContext = '';
    try {
      docText = await getFetchResults(npmUrl);
      if (!docText || docText.startsWith('Error:') || docText.length < 100) {
        console.warn(`\x1b[33m[PKG DOCS] npm page fetch failed for ${pkg}, trying search\x1b[0m`);
        const results = await getSearchResults(`${pkg} npm package documentation usage examples`, opts);
        if (results && results.length > 0) {
          searchContext = results.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n');
        }
      }
    } catch (e) {
      console.warn(`\x1b[33m[PKG DOCS] Fetch error for ${pkg}: ${e.message}\x1b[0m`);
      try {
        const results = await getSearchResults(`${pkg} npm usage api examples`, opts);
        if (results && results.length > 0) {
          searchContext = results.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n');
        }
      } catch {}
    }
    const combined = [docText, searchContext].filter(Boolean).join('\n\n');
    if (combined.length > 50) {
      try {
        const r = await callChat(
          [
            {
              role: 'system',
              content:
                'Extract key API usage, imports, constructor signatures, and example code from this npm package documentation. ' +
                'Output only a concise technical reference — installation command, import style, key functions with signatures, and 1-2 code examples. ' +
                'Max 400 words.',
            },
            { role: 'user', content: `Package: ${pkg}\n\nDocs:\n${combined.slice(0, 6000)}` },
          ],
          false,
          null,
          { ...opts, think: false, samplingProfile: 'json' }
        );
        docs[pkg] = (r.content || '').trim();
      } catch {
        docs[pkg] = combined.slice(0, 400);
      }
    } else {
      docs[pkg] = `Package: ${pkg} — documentation unavailable, use standard API patterns.`;
    }
    console.log(`\x1b[36m[PKG DOCS] ${pkg}: ${docs[pkg].length} chars of documentation\x1b[0m`);
  }
  return docs;
}

async function extractPackageList(callChat, task, requirementsSpec, opts = {}) {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Node.js dependency analyst. Given a project task and spec, list ALL npm packages needed.\n\n' +
          'RULES:\n' +
          '  - Only include packages that definitely exist on npm.\n' +
          '  - Do NOT include Node.js built-ins (fs, path, http, crypto, etc.).\n' +
          '  - Do NOT hallucinate package names — use only well-known packages.\n' +
          '  - Include both runtime dependencies and dev dependencies.\n' +
          '  - For frontend: consider express, ejs, socket.io, etc.\n' +
          '  - For auth: consider jsonwebtoken, bcrypt, express-session.\n' +
          '  - For DB: consider better-sqlite3, pg, mongoose, sequelize.\n' +
          '  - Never include packages whose names you are not 100% certain about.\n\n' +
          'Output ONLY valid JSON — no markdown fences:\n' +
          '{"dependencies":["pkg1","pkg2"],"devDependencies":["pkg3"]}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nSpec: ${JSON.stringify(requirementsSpec, null, 2)}`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'json' }
  );
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { dependencies: [], devDependencies: [] };
  }
}

async function requirementExpanderAgent(callChat, task, opts) {
  console.log('\x1b[36m[STEP 1] Expanding requirements from vague prompt...\x1b[0m');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Strategic Requirements Engineer. Your goal is to transform a vague user prompt into a high-fidelity technical specification that eliminates ambiguity for downstream agents.\n\n' +
          'SPECIFICATION PROTOCOL:\n' +
          '  1. Dimensional Inference: Analyze the prompt across five dimensions: Functional (what it does), Technical (how it\'s built), Experiential (how it feels), Security (how it\'s protected), and Operational (how it\'s deployed).\n' +
          '  2. Implicit Gap Filling: Identify a "Hidden Feature Set"—the essential components the user didn\'t mention but are required for a professional product (e.g., error handling, input validation, responsive layouts).\n' +
          '  3. Constraint Anchoring: Explicitly define technical boundaries (e.g., "SVG-only graphics", "Node.js fullstack", "Relative pathing").\n' +
          '  4. Boundary Mapping: Clearly define "Out-of-Scope" items to prevent scope creep and hallucinations.\n\n' +
          'MANDATORY PROJECT CONSTRAINTS:\n' +
          '  - Stack: Node.js + Express.js backend, static HTML/CSS/JS or EJS templates frontend.\n' +
          '  - Graphics: ALL icons/images MUST be inline SVG. No external URLs, no base64.\n' +
          '  - Architecture: Fullstack (Backend API + Frontend UI).\n\n' +
          'Output ONLY valid JSON — no markdown fences, no prose:\n' +
          '{\n' +
          '  "expandedSpec": "A rigorous, comprehensive technical specification in plain English.",\n' +
          '  "targetAudience": "Detailed description of the end-user persona.",\n' +
          '  "coreFeatures": ["Directly requested features"],\n' +
          '  "impliedFeatures": ["..."],\n' +
          '  "techConstraints": ["..."],\n' +
          '  "stackDecision": "...",\n' +
          '  "outOfScope": ["..."]\n' +
          '}',
      },
      { role: 'user', content: `User prompt: ${task}` },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'json' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const spec = JSON.parse(jsonStr);
    console.log(
      `\x1b[36m[STEP 1] Features: ${spec.coreFeatures?.length ?? 0} core, ${spec.impliedFeatures?.length ?? 0} implied\x1b[0m`
    );
    return spec;
  } catch {
    console.warn('\x1b[33m[STEP 1] JSON parse failed — using raw task\x1b[0m');
    return {
      expandedSpec: task,
      targetAudience: 'general users',
      coreFeatures: [],
      impliedFeatures: [],
      techConstraints: ['Node.js backend', 'SVG-only graphics', 'fullstack'],
      stackDecision: 'Express.js + EJS + vanilla JS',
      outOfScope: [],
    };
  }
}

async function architectureAgent(callChat, task, requirementsSpec, packageDocs, opts) {
  console.log('\x1b[36m[STEP 2] Architecture planning...\x1b[0m');
  const docsBlock = Object.keys(packageDocs).length
    ? `\nAvailable package documentation:\n${Object.entries(packageDocs).map(([k, v]) => `${k}:\n${v}`).join('\n\n---\n\n')}`
    : '';
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a System Design Architect specializing in Zero-Failure Integration. Your mission is to map the conceptual requirements into a concrete, implementable blueprint.\n\n' +
          'DESIGN PROTOCOLS:\n' +
          '  1. Dependency Mapping: Identify the precise data flow between the frontend (UI), backend (API), and persistence layer (DB/JSON).\n' +
          '  2. Interface Rigor: Define exact API contracts (methods, paths, expected payloads) to ensure workers don\'t guess signatures.\n' +
          '  3. Asset Strategy: Enforce the "Inline SVG Only" rule across all planned components.\n' +
          '  4. Deployment Path: Ensure the folder structure and entry point are optimized for immediate execution via `node server.js`.\n\n' +
          'TECHNICAL CONSTRAINTS:\n' +
          '  - Stack: Node.js + Express.js backend, static HTML/CSS/JS or EJS templates frontend.\n' +
          '  - Assets: ABSOLUTELY NO external image URLs or base64. SVG elements only.\n' +
          '  - Persistence: use better-sqlite3 or JSON files; avoid complex external DBs unless requested.\n' +
          '  - Auth: implement via jsonwebtoken + bcrypt if specified in requirements.\n\n' +
          'Output ONLY valid JSON — no markdown fences:\n' +
          '{\n' +
          '  "folderStructure": ["file1.js", "public/style.css", ...],\n' +
          '  "entryPoint": "server.js",\n' +
          '  "apiRoutes": [{"method":"GET","path":"/api/...","description":"..."}],\n' +
          '  "frontendPages": ["index.html", ...],\n' +
          '  "stateManagement": "...",\n' +
          '  "databaseStrategy": "...",\n' +
          '  "authStrategy": "...",\n' +
          '  "performanceStrategy": "...",\n' +
          '  "tasksForWorkers": [\n' +
          '    {"id":1,"label":"...","files":["..."],"description":"..."},\n' +
          '    ...\n' +
          '  ]\n' +
          '}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nSpec: ${JSON.stringify(requirementsSpec, null, 2)}${docsBlock}`,
      },
    ],
    false,
    null,
    { ...opts, think: true, samplingProfile: 'planning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const arch = JSON.parse(jsonStr);
    console.log(
      `\x1b[36m[STEP 2] Architecture: ${arch.folderStructure?.length ?? 0} files planned, ${arch.tasksForWorkers?.length ?? 0} worker tasks\x1b[0m`
    );
    return arch;
  } catch {
    console.warn('\x1b[33m[STEP 2] Architecture parse failed — using defaults\x1b[0m');
    return {
      folderStructure: ['server.js', 'package.json', 'public/index.html', 'public/style.css', 'public/app.js'],
      entryPoint: 'server.js',
      apiRoutes: [],
      frontendPages: ['public/index.html'],
      stateManagement: 'server-side sessions',
      databaseStrategy: 'JSON file storage',
      authStrategy: 'none',
      performanceStrategy: 'static file serving',
      tasksForWorkers: [
        { id: 1, label: 'Backend', files: ['server.js', 'package.json'], description: 'Express server and API' },
        { id: 2, label: 'Frontend', files: ['public/index.html', 'public/style.css', 'public/app.js'], description: 'UI pages' },
      ],
    };
  }
}

async function projectManagerAgent(callChat, task, architecture, requirementsSpec, opts) {
  console.log('\x1b[36m[STEP 3] Project Manager — breaking into worker tasks...\x1b[0m');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Strategic Project Manager and Technical Lead. Your goal is to translate a high-level architecture into a high-precision, dependency-aware execution roadmap.\n\n' +
          'SPRINT PLANNING PROTOCOL:\n' +
          '  1. Atomic Decomposition: Break the architecture into the smallest possible functional units (tickets). Each ticket must be a "complete" deliverable.\n' +
          '  2. Dependency Sequencing: Explicitly map the critical path. No ticket should be "ready" if its data dependencies (e.g., API contracts) are not yet defined.\n' +
          '  3. Ownership Specialization: Assign each ticket to a specific lens: "backend" (API/Logic), "frontend" (UI/UX), "database" (Persistence/Schema), "auth" (Security/Identity), or "testing" (Verification).\n' +
          '  4. Acceptance Rigor: Define binary "Pass/Fail" criteria for every ticket. Vague goals like "implement login" are forbidden; use "POST /auth/login returns JWT on valid creds".\n\n' +
          'Output ONLY valid JSON — no markdown fences:\n' +
          '{\n' +
          '  "tickets": [\n' +
          '    {\n' +
          '      "id": 1,\n' +
          '      "title": "Setup Express server",\n' +
          '      "owner": "backend",\n' +
          '      "priority": "critical",\n' +
          '      "files": ["server.js", "package.json"],\n' +
          '      "dependsOn": [],\n' +
          '      "acceptanceCriteria": ["server starts on port 3000", "GET / returns 200"]\n' +
          '    }\n' +
          '  ]\n' +
          '}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nArchitecture:\n${JSON.stringify(architecture, null, 2)}\n\nSpec:\n${JSON.stringify(requirementsSpec, null, 2)}`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'planning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const pm = JSON.parse(jsonStr);
    console.log(`\x1b[36m[STEP 3] PM: ${pm.tickets?.length ?? 0} sprint tickets created\x1b[0m`);
    return pm;
  } catch {
    return { tickets: architecture.tasksForWorkers || [] };
  }
}

async function coderWorkerAgent(callChat, task, ticket, existingFiles, architecture, requirementsSpec, packageDocs, opts) {
  const owner = ticket.owner || ticket.label || 'coder';
  console.log(`\x1b[36m[STEP 4] Coder Worker [${owner}] — ticket: ${ticket.title || ticket.label}\x1b[0m`);
  const existingContext = Object.entries(existingFiles)
    .filter(([f]) => ticket.files ? ticket.files.some(tf => f.includes(path.basename(tf))) : true)
    .map(([f, c]) => `\n// ${f}\n${(c || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const docsBlock = Object.keys(packageDocs).length
    ? `\nPackage documentation for reference:\n${Object.entries(packageDocs).map(([k, v]) => `${k}: ${v.slice(0, 300)}`).join('\n---\n')}\n`
    : '';
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a Senior ${owner} Engineer operating under a "Zero-Defect" mandate. Your goal is to implement your assigned ticket with maximum technical rigor and absolute adherence to the provided specification.\n\n` +
          `IMPLEMENTATION PROTOCOLS:\n` +
          `  1. Specification Literalism: Implement exactly what is in the ticket and architecture. Do NOT add "extra" features or "improve" the spec without explicit instruction.\n` +
          `  2. Interface Contract Adherence: If the architecture defines an API endpoint as POST /api/user, use exactly that path and method. No variations.\n` +
          `  3. Pure Inline Assets: Every single icon or graphic must be a hand-crafted inline SVG. NO external URLs, NO base64.\n` +
          `  4. Dependency Transparency: Use only the approved npm packages. If you need a new one, it must be justified in the output.\n` +
          `  5. Completeness Guarantee: No "// ...", no "TODO", no placeholders. Every file must be production-ready and runnable.\n\n` +
          `${file}\n\n` +
          `CRITICAL RULES:\n` +
          `  - Stack: Node.js + Express.js (backend), static HTML/CSS/JS or EJS (frontend)\n` +
          `  - ALL icons and graphics MUST be inline SVG — never use  for icons\n` +
          `  - NEVER reference external image URLs (no unsplash, no placeholder.com, no lorempixel)\n` +
          `  - NEVER use base64 image data in code — use SVG elements only\n` +
          `  - NEVER use broken relative paths — all static assets served from /public/\n` +
          `  - All href links in HTML must point to actual files in the project\n` +
          `  - package.json must use "type": "commonjs" unless ESM explicitly needed\n` +
          `  - Use require() not import for backend unless package.json has "type":"module"\n` +
          `  - CSS animations and transitions are fine; never use @import for external fonts without fallback\n` +
          `  - Google Fonts: use  tags in HTML head, not @import in CSS, with system-font fallback\n` +
          `  - Database file paths must use path.join(__dirname, ...) for portability\n` +
          `  - No TODO comments, no placeholder logic — ALL code must be complete and functional\n` +
          `${docsBlock}`,
      },
      {
        role: 'user',
        content:
          `Overall task: ${task}\n\n` +
          `Your ticket:\n${JSON.stringify(ticket, null, 2)}\n\n` +
          `Architecture context:\n${JSON.stringify(architecture, null, 2)}\n\n` +
          `Spec:\n${JSON.stringify(requirementsSpec, null, 2)}\n\n` +
          (existingContext ? `Existing files for context:\n${existingContext}\n\n` : '') +
          `Generate all files for this ticket now:`,
      },
    ],
    false,
    null,
    { ...opts, think: true, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let newFiles = parseFilesFromResponse(responseContent);
  newFiles = applyPatchBlocks(responseContent, { ...existingFiles, ...newFiles });
  const onlyNew = {};
  for (const [k, v] of Object.entries(newFiles)) {
    if (!(k in existingFiles) || newFiles[k] !== existingFiles[k]) onlyNew[k] = v;
  }
  console.log(`\x1b[36m[STEP 4] Worker [${owner}] produced: ${Object.keys(onlyNew).join(', ') || 'no new files'}\x1b[0m`);
  return onlyNew;
}

async function staticAnalysisAgent(callChat, files, task, opts) {
  console.log('\x1b[36m[STEP 5] Static Analysis — linting and syntax checking...\x1b[0m`');
  const issues = [];
  for (const [fname, content] of Object.entries(files)) {
    const ext = path.extname(fname).toLowerCase();
    const tmp = path.join(os.tmpdir(), `lint_${tmpSuffix()}${ext}`);
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const r = checkSyntaxAST(tmp);
        if (!r.valid) issues.push({ file: fname, type: 'syntax', error: r.error });
      }
    } catch (e) {
      issues.push({ file: fname, type: 'write_error', error: e.message });
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  const imgIssues = detectExternalImages(files);
  const linkIssues = detectBrokenLinks(files);
  issues.push(...imgIssues.map(i => ({ ...i, type: `asset_${i.type}` })));
  issues.push(...linkIssues.map(i => ({ ...i, type: `link_${i.type}` })));
  if (issues.length > 0) {
    console.warn(`\x1b[33m[STEP 5] Static analysis found ${issues.length} issues\x1b[0m`);
  } else {
    console.log('\x1b[32m[STEP 5] Static analysis passed\x1b[0m');
  }
  return issues;
}

async function testGenerationAgent(callChat, files, task, architecture, opts) {
  console.log('\x1b[36m[STEP 6] Test Generation — unit + integration + edge case tests...\x1b[0m');
  const filesSummary = Object.entries(files)
    .map(([f, c]) => `// FILE: ${f}\n${(c || '').slice(0, 1500)}`)
    .join('\n\n---\n\n');
  const apiRoutes = (Array.isArray(architecture.apiRoutes) ? architecture.apiRoutes : [])
    .map(r => `${r.method || 'GET'} ${r.path || '/'}: ${r.description || ''}`)
    .join('\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a Test Engineer. Generate a comprehensive test suite.\n\n` +
          `${file}\n\n` +
          `Output ONE test file named _tests.js using ### FILE: format.\n` +
          `The test file must:\n` +
          `  - Use only Node.js built-ins: assert, http, fs, path, child_process\n` +
          `  - Run standalone with: node _tests.js (server must be running on port 3000)\n` +
          `  - Print "ALL TESTS PASSED" to stdout on full success\n` +
          `  - For each failing test: print the test name and error clearly\n` +
          `  - Exit with code 0 if all pass, code 1 if any fail\n` +
          `  - Cover:\n` +
          `      * Happy paths for all API routes\n` +
          `      * Edge cases: empty inputs, missing fields, large payloads\n` +
          `      * Security: XSS strings in inputs, SQL injection attempts in query params\n` +
          `      * UI: verify all HTML pages return 200 with proper Content-Type\n` +
          `      * 404 handler: request a non-existent route\n` +
          `  - Use async/await with proper error catching\n` +
          `  - Each test wrapped in try/catch with descriptive name\n` +
          `  - Do NOT use describe/it/jest/mocha — plain functions only`,
      },
      {
        role: 'user',
        content:
          `Task: ${task}\n\nAPI Routes:\n${apiRoutes || '(none detected)'}\n\nCode:\n${filesSummary}\n\nGenerate comprehensive tests:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'code' }
  );
  const testFiles = parseFilesFromResponse(r.content || '');
  const testEntry = Object.keys(testFiles)[0];
  if (!testEntry) {
    const raw = stripCodeFences(r.content || '');
    if (raw.length > 10) return { testFile: '_tests.js', testCode: raw };
    return null;
  }
  return { testFile: testEntry, testCode: testFiles[testEntry] };
}

async function debuggingAgent(callChat, files, errorLog, task, opts) {
  console.log(`\x1b[36m[STEP 7] Debugging Agent — analyzing ${errorLog.length} errors...\x1b[0m`);
  const currentFilesBlock = Object.entries(files)
    .map(([fname, code]) => `\n${(code || '').slice(0, 3000)}\n`)
    .join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a Forensic Debugging Engineer. Your goal is to eliminate the provided errors by performing a root-cause analysis of the project state.\n\n${file}\n\n` +
          `REPAIR PROTOCOLS:\n` +
          `  1. Root Cause Isolation: Distinguish between "Symptom Errors" (e.g., 500 Internal Server Error) and "Root Cause Errors" (e.g., undefined variable in line 42).\n` +
          `  2. Path Integrity Audit: If a "Module Not Found" error occurs, verify the exact relative path against the architecture's folder structure.\n` +
          `  3. Asset Purge: If any asset issue is detected, immediately replace the offending tag with a professional inline SVG. No exceptions.\n` +
          `  4. Hallucination Correction: If a non-existent npm package was used, rewrite the logic using Node.js standard library or a verified alternative.\n` +
          `  5. Minimal Surface Area: Only output the files that MUST change. Do not rewrite stable code.\n` +
          `  6. Precision Patching: Use ### PATCH: for localized fixes to preserve the surrounding logic.`,
      },
      {
        role: 'user',
        content:
          `Task: ${task}\n\n` +
          `Errors to fix:\n${errorLog.join('\n')}\n\n` +
          `Current files:\n${currentFilesBlock}\n\n` +
          `Output corrected files:`,
      },
    ],
    false,
    null,
    { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return updatedFiles;
}

async function uxDesignAgent(callChat, files, task, requirementsSpec, opts) {
  console.log('\x1b[36m[STEP 8] UX/Design Agent — reviewing and improving aesthetics...\x1b[0m');
  const htmlCssFiles = Object.entries(files)
    .filter(([f]) => f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.ejs'))
    .map(([f, c]) => `\n// FILE: ${f}\n${(c || '').slice(0, 3000)}\n`)
    .join('\n\n');
  if (!htmlCssFiles) return null;
  const audience = requirementsSpec?.targetAudience || 'general users';
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Senior UX/UI Architect and Design Critic. Your goal is to transform a functional but plain interface into a professional, high-converting, and accessible product.\n\n' +
          'SENSORY & USABILITY LENSES:\n' +
          '  1. Visual Hierarchy: Audit typography, whitespace, and contrast. Ensure the "Primary Action" is unmistakable.\n' +
          '  2. Interaction Fidelity: Add sophisticated hover, active, and focus states using CSS transitions. No "jumpy" UI.\n' +
          '  3. Responsive Fluidity: Verify the layout across mobile, tablet, and desktop using modern CSS Grid/Flexbox. Ensure the viewport meta is correct.\n' +
          '  4. Accessible Aesthetics: Ensure WCAG AA contrast compliance and logical tab-index flow for keyboard-only users.\n' +
          '  5. State Communication: Design clear visual feedback for Loading, Empty, Error, and Success states.\n' +
          '  6. Asset Integrity: Flag any non-SVG image or external URL for immediate replacement with a professional SVG.\n\n' +
          `Target audience: ${audience}\n\n` +
          'Output ONLY valid JSON — no markdown fences, no prose:\n' +
          '{\n' +
          '  "issues": ["issue 1", "issue 2"],\n' +
          '  "suggestions": ["suggestion 1", "suggestion 2"],\n' +
          '  "score": 0\n' +
          '}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nFrontend files:\n${htmlCssFiles}\n\nUX review:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'reasoning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const result = JSON.parse(jsonStr);
    console.log(
      `\x1b[36m[STEP 8] UX: ${result.issues?.length ?? 0} issues, ${result.suggestions?.length ?? 0} suggestions, score=${result.score ?? 'N/A'}\x1b[0m`
    );
    return result;
  } catch {
    return null;
  }
}

async function securityPerformanceAgent(callChat, files, task, opts) {
  console.log('\x1b[36m[STEP 9] Security + Performance Review...\x1b[0m');
  const filesSummary = Object.entries(files)
    .map(([f, c]) => `\n// ${f}\n${(c || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Lead Security Architect and Performance Engineer. Your goal is to identify critical vulnerabilities and systemic bottlenecks that would compromise a production environment.\n\n' +
          'AUDIT VECTORS:\n' +
          '  1. Security Surface: Detect XSS (unescaped inputs), SQLi, CSRF, and Broken Access Control. Check for missing Helmet.js or missing rate-limiting on sensitive endpoints.\n' +
          '  2. Resource Efficiency: Identify N+1 queries, blocking Event Loop operations, unbounded loops, and memory leak patterns.\n' +
          '  3. Dependency Integrity: Detect hallucinated packages, missing version pins, or known vulnerable dependencies.\n' +
          '  4. Asset Compliance: Flag ANY external image URL or base64 image. Enforce 100% inline SVG compliance.\n' +
          '  5. Operational Risk: Check for exposed secrets in code or missing .env.example documentation.\n\n' +
          'Output ONLY valid JSON — no markdown fences, no prose:\n' +
          '{\n' +
          '  "criticalIssues": [{"file":"...","line":"...","type":"security|performance|asset","description":"...","fix":"..."}],\n' +
          '  "warnings": ["..."],\n' +
          '  "dependencyRisks": ["..."],\n' +
          '  "securityScore": 0,\n' +
          '  "performanceScore": 0\n' +
          '}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nFiles:\n${filesSummary}\n\nSecurity and performance audit:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'verify' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const result = JSON.parse(jsonStr);
    const criticalCount = result.criticalIssues?.length ?? 0;
    console.log(
      `\x1b[36m[STEP 9] Security: ${criticalCount} critical | sec=${result.securityScore ?? 'N/A'} perf=${result.performanceScore ?? 'N/A'}\x1b[0m`
    );
    return result;
  } catch {
    return null;
  }
}

async function userSimulationAgent(callChat, files, task, requirementsSpec, opts) {
  console.log('\x1b[36m[STEP 10] User Simulation Testing...\x1b[0m');
  const filesSummary = Object.entries(files)
    .map(([f, c]) => `\n${(c || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const audience = requirementsSpec?.targetAudience || 'general users';
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a User Experience Simulator and Behavioral Analyst. Your goal is to stress-test the interface by simulating a diverse set of human interaction patterns to find friction points and failure modes.\n\n' +
          'SIMULATION PERSONAS:\n' +
          '  1. The Power User: Searches for efficiency, keyboard shortcuts, and advanced feature combinations. Expects zero lag and high density.\n' +
          '  2. The Non-Technical Beginner: Misinterprets labels, ignores instructions, and makes illogical navigation leaps. Expects intuitive guidance.\n' +
          '  3. The Mobile/Constrained User: Interacts via touch, variable screen sizes, and intermittent connectivity. Expects responsiveness and a fluid layout.\n' +
          '  4. The Adversarial/Chaos User: Purposefully submits malformed data, rapid-clicks buttons, tests boundary cases, and attempts common XSS/Injection payloads.\n' +
          '  5. The Accessibility-First User: Navigates via screen readers and keyboard-only focus. Expects semantic HTML and high-contrast clarity.\n\n' +
          `Target audience: ${audience}\n\n` +
          'Output ONLY valid JSON — no markdown fences:\n' +
          '{\n' +
          '  "personaResults": [\n' +
          '    {"persona":"...", "painPoints":["..."], "blockers":["..."], "positives":["..."]}\n' +
          '  ],\n' +
          '  "topBlockers": ["..."],\n' +
          '  "accessibilityScore": 0,\n' +
          '  "overallUXScore": 0\n' +
          '}',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nProject files:\n${filesSummary}\n\nSimulate users:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'reasoning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const result = JSON.parse(jsonStr);
    console.log(
      `\x1b[36m[STEP 10] User Sim: ${result.personaResults?.length ?? 0} personas | UX=${result.overallUXScore ?? 'N/A'}\x1b[0m`
    );
    return result;
  } catch {
    return null;
  }
}

async function deploymentAgent(callChat, files, task, projectDir, opts) {
  console.log('\x1b[36m[STEP 11] Deployment Agent — generating deployment scripts...\x1b[0m');
  const fileList = Object.keys(files).join(', ');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are a Lead DevOps Engineer. Your goal is to create a production-ready deployment package that ensures the project is portable, secure, and easily deployable.\n\n' +
          `${file}\n\n` +
          'DEPLOYMENT ARTIFACTS:\n' +
          '  1. .env.example: A comprehensive template of all environment variables, including detailed comments for each.\n' +
          '  2. Dockerfile: Optimized multi-stage build using node:20-alpine, following security best practices (non-root user).\n' +
          '  3. docker-compose.yml: Orchestration including port mapping, persistent volumes for databases, and health checks.\n' +
          '  4. .gitignore: Strict exclusion of secrets, build artifacts, and local databases.\n' +
          '  5. README.md: Professional technical manual including Installation, Configuration, API Reference with curl examples, and Troubleshooting.\n\n' +
          'OPERATIONAL CONSTRAINTS:\n' +
          '  - Docker: Must use node:20-alpine, optimize layer caching, and run as non-root.\n' +
          '  - Compose: Use version "3.8" with explicit restart policies.\n' +
          '  - README: Must be high-fidelity, structured, and include a "Quick Start" section.\n' +
          '  - Env: Every variable must have a purpose-description in .env.example.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nProject files: ${fileList}\n\nGenerate deployment artifacts:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  const deployFiles = parseFilesFromResponse(responseContent);
  console.log(`\x1b[36m[STEP 11] Deployment: generated ${Object.keys(deployFiles).join(', ')}\x1b[0m`);
  return deployFiles;
}

function generateAutomationScript(files, architecture, task) {
  const port = 3000;
  const serverWaitRetries = 15;
  const apiRoutes = Array.isArray(architecture?.apiRoutes) ? architecture.apiRoutes : [];
  const htmlPages = Array.isArray(architecture?.frontendPages) ? architecture.frontendPages : ['public/index.html'];
  const routeTests = apiRoutes.map((route, i) => {
    if (typeof route !== 'object' || !route) return '';
    const method = (route.method || 'GET').toUpperCase();
    const rpath = route.path || '/';
    if (method === 'GET') {
      return `
  await runTest('Route: ${method} ${rpath}', async () => {
    const res = await httpRequest('${method}', '${rpath}');
    assert(res.statusCode < 500, \`Server error on ${rpath}: \${res.statusCode}\`);
    console.log(\`  ${method} ${rpath} → \${res.statusCode}\`);
  });`;
    } else {
      return `
  await runTest('Route: ${method} ${rpath}', async () => {
    const res = await httpRequest('${method}', '${rpath}', {});
    assert(res.statusCode !== 500, \`Server error on ${rpath}: \${res.statusCode}\`);
    console.log(\`  ${method} ${rpath} → \${res.statusCode}\`);
  });`;
    }
  }).join('');
  const pageTests = htmlPages.map(p => {
    if (typeof p !== 'string') return '';
    const urlPath = p.replace(/^public/, '').replace(/index\.html$/, '') || '/';
    return `
  await runTest('Page: ${urlPath}', async () => {
    const res = await httpRequest('GET', '${urlPath}');
    assert(res.statusCode === 200, \`Page not found: ${urlPath} (\${res.statusCode})\`);
    const ct = res.headers['content-type'] || '';
    assert(ct.includes('text/html'), \`Wrong content-type for ${urlPath}: \${ct}\`);
    console.log(\`  GET ${urlPath} → \${res.statusCode} OK\`);
  });`;
  }).join('');
  const edgeCaseTests = `
  await runTest('Edge: 404 for unknown route', async () => {
    const res = await httpRequest('GET', '/nonexistent_route_that_does_not_exist_abc123');
    assert(res.statusCode === 404, \`Expected 404, got \${res.statusCode}\`);
    console.log(\`  404 handler → \${res.statusCode} OK\`);
  });

  await runTest('Edge: XSS payload in query', async () => {
    const res = await httpRequest('GET', '/api/search?q=alert(1)');
    assert(res.statusCode < 500, \`Server crashed on XSS input: \${res.statusCode}\`);
    const body = res.body || '';
    const hasUnescaped = body.includes('alert(1)');
    if (hasUnescaped) errors.push('WARNING: XSS payload was reflected unescaped in response');
    console.log(\`  XSS query test → \${res.statusCode}\`);
  });

  await runTest('Edge: empty body POST', async () => {
    const firstPost = ${JSON.stringify(apiRoutes.find(r => r.method === 'POST')?.path || '/api/data')};
    const res = await httpRequest('POST', firstPost, {});
    assert(res.statusCode !== 500, \`Server crashed on empty POST body: \${res.statusCode}\`);
    console.log(\`  Empty POST → \${res.statusCode}\`);
  });

  await runTest('Edge: very large payload', async () => {
    const bigData = { data: 'x'.repeat(100000) };
    const firstPost = ${JSON.stringify(apiRoutes.find(r => r.method === 'POST')?.path || '/api/data')};
    const res = await httpRequest('POST', firstPost, bigData);
    assert(res.statusCode !== 500, \`Server crashed on large payload: \${res.statusCode}\`);
    console.log(\`  Large payload POST → \${res.statusCode}\`);
  });`;
  const allFormSelectors = (() => {
    const selectors = [];
    for (const [fname, content] of Object.entries(files)) {
      if (!fname.endsWith('.html') && !fname.endsWith('.ejs')) continue;
      const formRe = /]*action=["']([^"']*)["'][^>]*>/gi;
      let m;
      while ((m = formRe.exec(content)) !== null) selectors.push(m[1]);
    }
    return selectors;
  })();
  return `'use strict';
// _automation.js — comprehensive automation + UI testing script
// Run with: node _automation.js (requires server on port ${port})

const http = require('http');
const https = require('https');
const assert = require('assert');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || ${port};
const BASE = \`http://localhost:\${PORT}\`;
const errors = [];
const results = { passed: 0, failed: 0, warnings: 0 };

function httpRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/html,application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...extraHeaders,
      },
      timeout: 8000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (e) => resolve({ statusCode: 0, headers: {}, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0, headers: {}, body: '', error: 'timeout' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runTest(name, fn) {
  try {
    await fn();
    results.passed++;
    console.log(\`  ✓ \${name}\`);
  } catch (e) {
    results.failed++;
    errors.push(\`FAIL [\${name}]: \${e.message}\`);
    console.error(\`  ✗ \${name}: \${e.message}\`);
  }
}

async function waitForServer(maxRetries = ${serverWaitRetries}) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await httpRequest('GET', '/');
      if (res.statusCode > 0 && res.statusCode !== 0) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
    process.stdout.write(\`  Waiting for server... \${i + 1}/\${maxRetries}\\r\`);
  }
  return false;
}

function checkHtmlForIssues(html, pageName) {
  const issues = [];
  const externalImgRe = /src=["']https?:\\/\\/[^"']+\\.(png|jpg|jpeg|gif|webp|ico)["']/gi;
  const base64Re = /src=["']data:image\\/(png|jpg|jpeg|gif|webp);base64,/gi;
  let m;
  while ((m = externalImgRe.exec(html)) !== null)
    issues.push(\`External image URL in \${pageName}: \${m[0].slice(0, 80)}\`);
  while ((m = base64Re.exec(html)) !== null)
    issues.push(\`Base64 image in \${pageName} (use SVG instead)\`);
  if (!html.includes('<meta name="viewport"'))
    issues.push(\`Missing viewport meta tag in \${pageName}\`);
  return issues;
}

async function main() {
  console.log('\\n=== AUTOMATION TESTING SUITE ===');
  console.log(\`Target: \${BASE}\\n\`);

  console.log('Waiting for server to be ready...');
  const ready = await waitForServer();
  if (!ready) {
    console.error('ERROR: Server did not start within ${serverWaitRetries} seconds');
    process.exit(1);
  }
  console.log('Server is ready!\\n');

  console.log('--- PAGE TESTS ---');
${pageTests}

  console.log('\\n--- API ROUTE TESTS ---');
${routeTests || '  // No API routes detected'}

  console.log('\\n--- EDGE CASE TESTS ---');
${edgeCaseTests}

  console.log('\\n--- HTML QUALITY CHECKS ---');
  await runTest('HTML: Check all pages for asset issues', async () => {
    const pages = ${JSON.stringify(htmlPages)};
    const htmlIssues = [];
    for (const page of pages) {
      const urlPath = page.replace(/^public/, '').replace(/index\\.html$/, '') || '/';
      const res = await httpRequest('GET', urlPath);
      if (res.statusCode === 200 && res.body) {
        const pageIssues = checkHtmlForIssues(res.body, page);
        htmlIssues.push(...pageIssues);
      }
    }
    if (htmlIssues.length > 0) {
      htmlIssues.forEach(issue => errors.push('HTML ISSUE: ' + issue));
      console.log('  HTML issues found: ' + htmlIssues.length);
    }
  });

  await runTest('HTML: Check for broken form actions', async () => {
    const formActions = ${JSON.stringify(allFormSelectors)};
    for (const action of formActions) {
      if (!action || action.startsWith('#') || action.startsWith('http')) continue;
      const res = await httpRequest('POST', action, { test: 'automation' });
      assert(res.statusCode !== 404, \`Form action \${action} returns 404\`);
    }
  });

  await runTest('Concurrency: 10 simultaneous requests', async () => {
    const promises = Array.from({ length: 10 }, () => httpRequest('GET', '/'));
    const responses = await Promise.all(promises);
    const failed = responses.filter(r => r.statusCode === 0 || r.statusCode >= 500);
    assert(failed.length === 0, \`\${failed.length}/10 concurrent requests failed\`);
  });

  console.log('\\n=== RESULTS ===');
  console.log(\`Passed: \${results.passed}\`);
  console.log(\`Failed: \${results.failed}\`);
  console.log(\`Warnings: \${errors.filter(e => e.startsWith('WARNING')).length}\`);

  if (errors.length > 0) {
    console.log('\\n--- ERRORS & WARNINGS ---');
    errors.forEach(e => console.log('  ' + e));
  }

  if (results.failed === 0) {
    console.log('\\nALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log(\`\\n\${results.failed} TESTS FAILED\`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
`;
}

async function continuousFeedbackAgent(callChat, files, testResults, staticIssues, securityResult, uxResult, userSimResult, task, iterationNumber, opts) {
  console.log(`\x1b[36m[STEP 12/FEEDBACK] Continuous feedback loop — iteration ${iterationNumber}...\x1b[0m`);
  const allIssues = [];
  if (staticIssues && staticIssues.length > 0) {
    allIssues.push(...staticIssues.map(i => `[STATIC/${i.type?.toUpperCase()}] ${i.file}: ${i.error || i.ref || i.match}`));
  }
  if (securityResult?.criticalIssues?.length) {
    for (const issue of securityResult.criticalIssues) {
      allIssues.push(`[SECURITY/${issue.type?.toUpperCase() ?? 'CRITICAL'}] ${issue.file}: ${issue.description} — Fix: ${issue.fix}`);
    }
  }
  if (uxResult?.issues?.length) {
    for (const issue of uxResult.issues) allIssues.push(`[UX] ${issue}`);
  }
  if (userSimResult?.topBlockers?.length) {
    for (const blocker of userSimResult.topBlockers) allIssues.push(`[USER_SIM_BLOCKER] ${blocker}`);
  }
  if (testResults?.failed > 0 && testResults?.errors?.length) {
    for (const err of testResults.errors) allIssues.push(`[TEST_FAIL] ${err}`);
  }
  if (allIssues.length === 0) {
    console.log('\x1b[32m[FEEDBACK] No issues remaining — project is ready\x1b[0m');
    return { files, done: true };
  }
  console.log(`\x1b[33m[FEEDBACK] ${allIssues.length} issues to fix in iteration ${iterationNumber}\x1b[0m`);
  const currentFilesBlock = Object.entries(files)
    .map(([fname, code]) => `\n${(code || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a Continuous Improvement Agent (iteration ${iterationNumber}). Fix ALL listed issues.\n\n${file}\n\n` +
          `CRITICAL RULES:\n` +
          `  - Replace ALL external image URLs with inline SVG placeholders\n` +
          `  - Replace ALL base64 images with inline SVG\n` +
          `  - Fix ALL broken relative paths\n` +
          `  - Fix ALL security issues\n` +
          `  - Fix ALL failing tests\n` +
          `  - Output ONLY files that changed — do NOT re-output unchanged files`,
      },
      {
        role: 'user',
        content:
          `Issues to fix (iteration ${iterationNumber}):\n${allIssues.map((i, n) => `${n + 1}. ${i}`).join('\n')}\n\n` +
          `Current files:\n${currentFilesBlock}\n\nOutput corrected files:`,
      },
    ],
    false,
    null,
    { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return { files: updatedFiles, done: false };
}

async function runFullAutomationTests(projectDir, entryPoint, files, architecture, task, buildCmds, runCmds) {
  const automationScript = generateAutomationScript(files, architecture, task);
  const automationPath = path.join(projectDir, '_automation.js');
  fs.writeFileSync(automationPath, automationScript, 'utf-8');
  let serverProc = null;
  const results = { passed: 0, failed: 0, errors: [], warnings: [] };
  try {
    const startCmd = (runCmds || `node ${entryPoint}`).split(' ');
    serverProc = spawn(startCmd[0], startCmd.slice(1), {
      cwd: projectDir,
      env: { ...process.env, PORT: '3000', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', d => {
      const msg = d.toString();
      if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed')) {
        results.errors.push(`SERVER STDERR: ${msg.trim()}`);
      }
    });
    await new Promise(r => setTimeout(r, 3000));
    const testOutput = await new Promise((resolve) => {
      let out = '', err = '';
      const testProc = spawn(process.execPath, ['_automation.js'], {
        cwd: projectDir,
        env: { ...process.env, PORT: '3000' },
        timeout: 60000,
      });
      testProc.stdout.on('data', c => { out += c; process.stdout.write(c); });
      testProc.stderr.on('data', c => { err += c; });
      const t = setTimeout(() => { testProc.kill('SIGKILL'); }, 60000);
      testProc.on('close', code => {
        clearTimeout(t);
        resolve({ out, err, exitCode: code });
      });
    });
    const passMatch = testOutput.out.match(/Passed:\s*(\d+)/);
    const failMatch = testOutput.out.match(/Failed:\s*(\d+)/);
    if (passMatch) results.passed = parseInt(passMatch[1]);
    if (failMatch) results.failed = parseInt(failMatch[1]);
    const failLines = testOutput.out.split('\n').filter(l => l.trim().startsWith('✗') || l.includes('FAIL [') || l.includes('TESTS FAILED'));
    results.errors.push(...failLines);
    if (testOutput.err) results.errors.push(`TEST RUNNER STDERR: ${testOutput.err.slice(0, 500)}`);
    console.log(`\x1b[36m[AUTOMATION] Results: ${results.passed} passed, ${results.failed} failed\x1b[0m`);
  } catch (e) {
    results.errors.push(`Automation runner error: ${e.message}`);
    console.warn(`\x1b[33m[AUTOMATION] Runner error: ${e.message}\x1b[0m`);
  } finally {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
  }
  return results;
}

async function oracleFixLoop(callChat, files, oracleTrace, opts) {
  const currentFilesBlock = Object.entries(files)
    .map(([fname, code]) => `\n${(code || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a test-failure repair engine. Fix the code so all tests pass.\n\n${file}\n\n` +
          `REPAIR RULES:\n` +
          `  - Output ONLY files that need changes.\n` +
          `  - Use ### PATCH: for small targeted changes, ### FILE: for full rewrites.\n` +
          `  - Do NOT modify _tests.js or _automation.js unless they are factually wrong.\n` +
          `  - Fix the implementation to match the test expectations.\n` +
          `  - For 404 failures: add missing routes to server.js\n` +
          `  - For 500 failures: add error handling and input validation\n` +
          `  - For asset issues: replace with inline SVG`,
      },
      {
        role: 'user',
        content:
          `Current files:\n\n${currentFilesBlock}\n\n` +
          `Test failures:\n${oracleTrace}\n\n` +
          `Output corrected files:`,
      },
    ],
    false,
    null,
    { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return updatedFiles;
}

async function fixLoop(callChat, files, errorMsg, fixHistoryCache, fingerprint, opts) {
  const fp = fingerprint(errorMsg, files);
  const isRepeated = fixHistoryCache.has(fp);
  fixHistoryCache.add(fp);
  const divergenceNote = isRepeated
    ? '\n\nWARNING: This exact error + code combination was already attempted. ' +
      'You MUST use a fundamentally different approach.'
    : '';
  const currentFilesBlock = Object.entries(files)
    .map(([fname, code]) => `\n${(code || '').slice(0, 3000)}\n`)
    .join('\n\n');
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are a code repair engine. Fix the error in the project files.\n\n${file}\n\n` +
          `REPAIR RULES:\n` +
          `  - Output ONLY the files that need changes — do NOT re-output unchanged files.\n` +
          `  - Prefer stdlib over external packages.\n` +
          `  - If a hallucinated package caused the error, rewrite without it.\n` +
          `  - For small targeted changes, use ### PATCH: format.\n` +
          `  - For larger rewrites, use ### FILE: format with the complete corrected file.\n` +
          `  - Do NOT add explanatory prose — only ### FILE: or ### PATCH: blocks.\n` +
          `${divergenceNote}`,
      },
      {
        role: 'user',
        content:
          `Current files:\n\n${currentFilesBlock}\n\n` +
          `Error:\n${errorMsg}\n\n` +
          `Output corrected files:`,
      },
    ],
    false,
    null,
    { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  if (
    Object.keys(newFiles).length === 0 &&
    !responseContent.includes('---FIND---') &&
    !responseContent.includes('<<<SEARCH')
  ) {
    console.warn('\x1b[33m[FIX LOOP] No structured blocks found — attempting raw fallback parse\x1b[0m');
    const retryFiles = parseFilesFromResponse(
      responseContent.replace(/^[^`]*/, '').replace(/[^`]*$/, '')
    );
    if (Object.keys(retryFiles).length > 0) Object.assign(updatedFiles, retryFiles);
  }
  return updatedFiles;
}

const excluded = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.cache', '.npm', 'dist', 'build', '.git']);
const excluded1 = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'Pipfile.lock']);

function safeRmSync(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`\x1b[33m[CLEANUP] Could not remove ${dir}: ${e.message}\x1b[0m`);
  }
}

async function mathematicianAgent(callChat, task, inputText, opts) {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          'You are The Mathematician. Write a precise mathematical specification.\n' +
          'RULES:\n' +
          '  - NO code, NO prose explanations.\n' +
          '  - Use exact notation: formulas, iteration bounds, edge cases.\n' +
          'Format:\n' +
          'Step 1: [Formula/object with full definition]\n' +
          'Step 2: [Algorithm with exact iteration bounds]\n' +
          'Step 3: [Edge cases and constraints]\n' +
          'Step 4: [Expected output format]\n' +
          'Step 5: [Verification method]',
      },
      { role: 'user', content: `Task: ${task}\n\nProblem:\n${inputText}\n\nSpec:` },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'reasoning' }
  );
  return (r.content || '').trim();
}

async function engineerAgent(callChat, mathSpec, task, inputText, language, opts) {
  const isJS = language === 'javascript';
  const label = isJS ? 'JavaScript (Node.js)' : 'Python 3';
  const outFn = isJS ? 'console.log()' : 'print()';
  const libs = isJS
    ? 'Use BigInt for large integers. Implement combinatorics with BigInt.'
    : 'Prefer sympy/fractions for exact arithmetic. Use itertools for enumeration.';
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `You are The Software Engineer. Implement the mathematical spec EXACTLY — do NO math yourself.\n` +
          `RULES:\n` +
          `  - NEVER hardcode computed values — always compute them.\n` +
          `  - ${outFn} must be the LAST statement in the script.\n` +
          `  - Output ONLY the complete runnable script — no explanation, no markdown fences.\n` +
          `  - ${libs}`,
      },
      {
        role: 'user',
        content: `Spec:\n${mathSpec}\n\nTask: ${task}\n\nProblem:\n${inputText}\n\nWrite the complete ${label} script:`,
      },
    ],
    false,
    null,
    { ...opts, think: false, samplingProfile: 'code' }
  );
  return stripCodeFences(r.content || '');
}

async function fixCodeRuntime(callChat, task, code, language, error) {
  const r = await callChat(
    [
      {
        role: 'system',
        content:
          `Fix the ${language} runtime error below.\n` +
          'Output ONLY the complete corrected script — no explanation, no markdown fences.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nCode:\n${code}\n\nError:\n${error}\n\nFixed script:`,
      },
    ],
    false,
    null,
    { think: false, samplingProfile: 'code' }
  );
  return stripCodeFences(r.content || '');
}

async function runMCTSApproaches(callChat, task, inputText, opts = {}) {
  if (!PYTHON_BIN) return null;
  const isSimpleMath = /calculate|multiply|add|subtract|sum/i.test(task) && task.length < 50;
  if (isSimpleMath) return null;
  const NUM = opts.mctsNumApproaches ?? 4, THRESHOLD = opts.mctsConsensusThreshold ?? 3;
  const approaches = [], usedDomains = [];
  for (let i = 0; i < NUM; i++) {
    const priorNote = approaches.length
      ? `\nAlready used: ${approaches.map(a => `[${a.domain}]`).join(', ')}. Use a different domain from: ${math.filter(d => !usedDomains.includes(d)).join(', ')}`
      : `\nAvailable domains: ${math.join(', ')}`;
    const r = await callChat(
      [
        {
          role: 'system',
          content:
            'Generate ONE unique algorithmic approach using a specific mathematical domain.\n' +
            'Output ONLY valid JSON: {"name":"...","domain":"...","algorithm":"..."}\n' +
            'No prose, no markdown fences.',
        },
        {
          role: 'user',
          content: `Task: ${task}\nProblem: ${inputText}${priorNote}\nApproach ${i + 1}:`,
        },
      ],
      false,
      null,
      { ...opts, think: false, samplingProfile: 'json' }
    );
    try {
      const p = JSON.parse(stripCodeFences(r.content || '{}'));
      if (p.algorithm && p.domain) {
        approaches.push(p);
        usedDomains.push(p.domain);
      }
    } catch {}
  }
  if (new Set(approaches.map(a => a.domain)).size < 2) return null;
  const settled = await Promise.allSettled(
    approaches.map(async ap => {
      const aTask = `${task}\nAlgorithm to use: ${ap.algorithm}`;
      const spec = await mathematicianAgent(callChat, aTask, inputText, opts);
      let code = await engineerAgent(callChat, spec, aTask, inputText, 'python', opts);
      let output = null;
      for (let a = 0; a < 2; a++) {
        try {
          output = await runPythonSandbox(code);
          break;
        } catch (e) {
          if (a < 1) code = await fixCodeRuntime(callChat, aTask, code, 'python', e.message);
          else throw e;
        }
      }
      if (!output) throw new Error(`No output from "${ap.name}"`);
      console.log(`\x1b[35m[MCTS] "${ap.name}" [${ap.domain}] → ${output.slice(0, 60)}\x1b[0m`);
      return { domain: ap.domain, result: output };
    })
  );
  const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) return null;
  const freq = new Map();
  for (const s of ok) {
    let found = false;
    for (const [k, e] of freq) {
      if (compareResults(k, s.result)) {
        e.count++;
        e.domains.push(s.domain);
        found = true;
        break;
      }
    }
    if (!found) freq.set(s.result, { count: 1, result: s.result, domains: [s.domain] });
  }
  let best = null;
  for (const e of freq.values()) if (!best || e.count > best.count) best = e;
  if (!best) return null;
  const distinctDomains = new Set(best.domains);
  const confidence =
    best.count >= THRESHOLD && distinctDomains.size >= 2
      ? 'HIGH'
      : best.count >= 2
      ? 'MEDIUM'
      : 'LOW';
  console.log(
    `\x1b[35m[MCTS] Consensus: ${best.result} — ${best.count}/${ok.length} agree — confidence=${confidence}\x1b[0m`
  );
  return { result: best.result, count: best.count, total: ok.length, confidence, sandboxValidated: true };
}

async function reconcileResults(jsResult, pyResult) {
  if (jsResult === pyResult) return jsResult;
  if (compareResults(jsResult, pyResult)) return jsResult;
  return pyResult !== null ? pyResult : jsResult;
}

async function generateAndRunCode(callChat, task, inputText, opts = {}) {
  const max = 2;
  if (opts.mcts !== false) {
    try {
      const m = await runMCTSApproaches(callChat, task, inputText, opts);
      if (m && m.confidence !== 'LOW') {
        return { result: m.result, jsResult: null, pyResult: m.result, sandboxValidated: true, mctsConsensus: m };
      }
    } catch (e) {
      console.warn(`\x1b[33m[MCTS] ${e.message} — falling back\x1b[0m`);
    }
  }
  const spec = await mathematicianAgent(callChat, task, inputText, opts);
  let jsCode = await engineerAgent(callChat, spec, task, inputText, 'javascript', opts);
  let jsResult = '';
  for (let a = 0; a < max; a++) {
    try {
      jsResult = await runJSSandbox(jsCode);
      break;
    } catch (e) {
      const isOOM = /killed|oom|timeout/i.test(e.message);
      if (isOOM && a === 0) {
        const constrained = task + '\nPREVIOUS FAILED: OOM/TIMEOUT. Derive O(N²) or better algorithm.';
        jsCode = await engineerAgent(
          callChat,
          await mathematicianAgent(callChat, constrained, inputText, opts),
          constrained,
          inputText,
          'javascript',
          opts
        );
      } else if (a < max - 1) {
        jsCode = await fixCodeRuntime(callChat, task, jsCode, 'javascript', e.message);
      } else throw e;
    }
  }
  let pyResult = null;
  if (PYTHON_BIN) {
    let pyCode = await engineerAgent(callChat, spec, task, inputText, 'python', opts);
    for (let a = 0; a < max; a++) {
      try {
        pyResult = await runPythonSandbox(pyCode);
        break;
      } catch (e) {
        if (a < max - 1) pyCode = await fixCodeRuntime(callChat, task, pyCode, 'python', e.message);
        else { pyResult = null; break; }
      }
    }
  }
  const result = pyResult !== null ? await reconcileResults(jsResult, pyResult) : jsResult;
  return { result, jsResult, pyResult, sandboxValidated: true };
}

async function generateAndRunProject(callChat, task, opts = {}) {
  const maxBugFixLoops = opts.maxProjectLoops || 6;
  const maxOracleLoops = opts.maxOracleLoops || 3;
  const maxFeedbackLoops = opts.maxFeedbackLoops || 3;
  const thinkingDepth = opts.thinkingDepth ?? 2;
  const projectDir = path.join(os.tmpdir(), `project_gen_${tmpSuffix()}`);
  const fixHistoryCache = new Set();

  function fingerprint(error, files) {
    const sig = error + Object.keys(files).sort().join(',');
    let h = 5381;
    for (let i = 0; i < sig.length; i++) h = (h << 5) + h + sig.charCodeAt(i);
    return String(h >>> 0);
  }

  try {
    console.log('\x1b[36m[STEP 1] Requirement Expansion...\x1b[0m');
    const requirementsSpec = await requirementExpanderAgent(callChat, task, opts);
    const expandedTask = requirementsSpec.expandedSpec || task;

    console.log('\x1b[36m[STEP 2] Architecture Planning...\x1b[0m');
    const packageList = await extractPackageList(callChat, expandedTask, requirementsSpec, opts);
    const allPackages = [...(packageList.dependencies || []), ...(packageList.devDependencies || [])];
    const packageDocs = await fetchPackageDocumentation(callChat, allPackages, opts);
    const architecture = await architectureAgent(callChat, expandedTask, requirementsSpec, packageDocs, opts);

    console.log('\x1b[36m[STEP 3] Project Manager — Sprint Tickets...\x1b[0m');
    const projectPlan = await projectManagerAgent(callChat, expandedTask, architecture, requirementsSpec, opts);
    const tickets = projectPlan.tickets || architecture.tasksForWorkers || [];

    console.log('\x1b[36m[STEP 4] Coder Workers — parallel file generation...\x1b[0m');
    let files = {};
    const workerGroups = [
      tickets.filter(t => (t.owner || t.label || '').toLowerCase().includes('backend') || (t.owner || t.label || '').toLowerCase().includes('server')),
      tickets.filter(t => (t.owner || t.label || '').toLowerCase().includes('frontend') || (t.owner || t.label || '').toLowerCase().includes('ui')),
      tickets.filter(t => (t.owner || t.label || '').toLowerCase().includes('db') || (t.owner || t.label || '').toLowerCase().includes('database') || (t.owner || t.label || '').toLowerCase().includes('auth')),
      tickets.filter(t => !(t.owner || t.label || '').toLowerCase().match(/backend|server|frontend|ui|db|database|auth/)),
    ].filter(g => g.length > 0);
    if (workerGroups.length === 0 && tickets.length === 0) {
      workerGroups.push([{ id: 1, label: 'fullstack', owner: 'fullstack', title: 'Generate complete project', files: architecture.folderStructure || [], description: expandedTask }]);
    }
    for (const group of workerGroups) {
      const groupResults = await Promise.all(
        group.map(ticket =>
          coderWorkerAgent(callChat, expandedTask, ticket, files, architecture, requirementsSpec, packageDocs, opts)
            .catch(e => { console.warn(`\x1b[33m[WORKER] Ticket ${ticket.id} failed: ${e.message}\x1b[0m`); return {}; })
        )
      );
      for (const result of groupResults) Object.assign(files, result);
    }
    if (Object.keys(files).length === 0) {
      console.warn('\x1b[33m[STEP 4] No files from workers — falling back to single-pass generation\x1b[0m');
      const r = await callChat(
        [
          {
            role: 'system',
            content: `You are a code generation engine. Generate a complete fullstack Node.js project.\n\n${file}\n\n` +
              `CONSTRAINTS:\n  - Node.js + Express.js backend\n  - All graphics must be inline SVG\n  - No external image URLs\n  - Must include package.json`,
          },
          { role: 'user', content: `Task: ${expandedTask}\n\nArchitecture:\n${JSON.stringify(architecture, null, 2)}\n\nGenerate all project files:` },
        ],
        false,
        null,
        { ...opts, think: thinkingDepth >= 2, samplingProfile: 'code' }
      );
      files = parseFilesFromResponse(r.content || '');
      files = applyPatchBlocks(r.content || '', files);
    }

    if (!files['package.json']) {
      const deps = {};
      for (const pkg of (packageList.dependencies || [])) deps[pkg] = 'latest';
      files['package.json'] = JSON.stringify({
        name: task.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 50),
        version: '1.0.0',
        description: task,
        main: architecture.entryPoint || 'server.js',
        scripts: { start: `node ${architecture.entryPoint || 'server.js'}`, test: 'node _tests.js' },
        dependencies: { express: '^4.18.0', ...deps },
        devDependencies: {},
      }, null, 2);
    }

    fs.mkdirSync(projectDir, { recursive: true });
    let buildCmds = '';
    let runCmds = `node ${architecture.entryPoint || 'server.js'}`;

    for (const [fname, fcontent] of Object.entries(files)) {
      const filePath = path.join(projectDir, fname);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fcontent || '', 'utf-8');
    }

    console.log('\x1b[36m[STEP 5] Static Analysis...\x1b[0m');
    let staticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);

    console.log('\x1b[36m[STEP 5b] Installing dependencies...\x1b[0m');
    try {
      if (fs.existsSync(path.join(projectDir, 'package.json'))) {
        execSync('npm install', { cwd: projectDir, stdio: 'pipe', timeout: 120_000 });
        buildCmds = 'npm install';
        console.log('\x1b[32m[STEP 5b] npm install succeeded\x1b[0m');
      }
    } catch (e) {
      console.warn(`\x1b[33m[STEP 5b] npm install failed: ${e.message.slice(0, 200)}\x1b[0m`);
      staticIssues.push({ file: 'package.json', type: 'npm_install_error', error: e.message.slice(0, 200) });
    }

    console.log('\x1b[36m[STEP 6] Test Generation...\x1b[0m');
    const testOracle = await testGenerationAgent(callChat, files, expandedTask, architecture, opts);
    if (testOracle?.testCode) {
      const testPath = path.join(projectDir, testOracle.testFile || '_tests.js');
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, testOracle.testCode, 'utf-8');
      files[path.relative(projectDir, testPath)] = testOracle.testCode;
    }

    const automationScript = generateAutomationScript(files, architecture, expandedTask);
    const automationPath = path.join(projectDir, '_automation.js');
    fs.writeFileSync(automationPath, automationScript, 'utf-8');
    files['_automation.js'] = automationScript;

    let execErrorMsg = '';
    let syntaxPassed = true;
    for (const [fname] of Object.entries(files)) {
      if (fname.startsWith('_')) continue;
      const filePath = path.join(projectDir, fname);
      if (!fs.existsSync(filePath)) continue;
      const chk = checkSyntaxAST(filePath);
      if (!chk.valid) {
        syntaxPassed = false;
        execErrorMsg += `[Syntax Error in ${fname}]:\n${chk.error}\n\n`;
      }
    }

    if (!syntaxPassed) {
      console.warn('\x1b[33m[STEP 5] Syntax errors — routing to debugger\x1b[0m');
      files = await debuggingAgent(callChat, files, [execErrorMsg], expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        const fp2 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp2), { recursive: true });
        fs.writeFileSync(fp2, fcontent || '', 'utf-8');
      }
    }

    for (let bugIter = 1; bugIter <= maxBugFixLoops; bugIter++) {
      console.log(`\x1b[36m[STEP 7] Bug Fix Loop ${bugIter}/${maxBugFixLoops}...\x1b[0m`);
      let runtimeErr = '';
      try {
        execSync(`node --check "${path.join(projectDir, architecture.entryPoint || 'server.js')}"`, { stdio: 'pipe' });
      } catch (e) {
        runtimeErr = (e.stderr ? e.stderr.toString() : '') + (e.message || '');
      }
      const allErrors = [
        ...staticIssues.filter(i => i.type !== 'asset_external_img_tag' && i.type !== 'link_broken_href').map(i => `[${i.type}] ${i.file}: ${i.error || i.ref || ''}`),
        ...(runtimeErr ? [`[RUNTIME] ${runtimeErr.slice(0, 500)}`] : []),
      ];
      if (allErrors.length === 0) {
        console.log(`\x1b[32m[STEP 7] No critical errors on iteration ${bugIter}\x1b[0m`);
        break;
      }
      files = await debuggingAgent(callChat, files, allErrors, expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        const fp3 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp3), { recursive: true });
        fs.writeFileSync(fp3, fcontent || '', 'utf-8');
      }
      staticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
    }

    console.log('\x1b[36m[STEP 8] UX/Design Review...\x1b[0m');
    const uxResult = await uxDesignAgent(callChat, files, expandedTask, requirementsSpec, opts);

    console.log('\x1b[36m[STEP 9] Security + Performance Review...\x1b[0m');
    const securityResult = await securityPerformanceAgent(callChat, files, expandedTask, opts);

    console.log('\x1b[36m[STEP 10] User Simulation Testing...\x1b[0m');
    const userSimResult = await userSimulationAgent(callChat, files, expandedTask, requirementsSpec, opts);

    let automationTestResults = { passed: 0, failed: 0, errors: [] };
    console.log('\x1b[36m[STEP 10b] Running full automation test suite...\x1b[0m');
    try {
      automationTestResults = await runFullAutomationTests(
        projectDir,
        architecture.entryPoint || 'server.js',
        files,
        architecture,
        expandedTask,
        buildCmds,
        runCmds
      );
    } catch (e) {
      console.warn(`\x1b[33m[AUTOMATION] Test run error: ${e.message}\x1b[0m`);
      automationTestResults.errors.push(e.message);
    }

    for (let oracleIter = 0; oracleIter < maxOracleLoops; oracleIter++) {
      if (automationTestResults.failed === 0 && automationTestResults.errors.length === 0) break;
      console.log(`\x1b[33m[STEP 6b] Oracle fix loop ${oracleIter + 1}/${maxOracleLoops}...\x1b[0m`);
      files = await oracleFixLoop(callChat, files, automationTestResults.errors.join('\n'), opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        if (fname === '_automation.js') continue;
        const fp4 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp4), { recursive: true });
        fs.writeFileSync(fp4, fcontent || '', 'utf-8');
      }
      try {
        automationTestResults = await runFullAutomationTests(
          projectDir,
          architecture.entryPoint || 'server.js',
          files,
          architecture,
          expandedTask,
          buildCmds,
          runCmds
        );
      } catch (e) {
        automationTestResults.errors.push(e.message);
      }
    }

    console.log('\x1b[36m[STEP 11] Deployment Artifacts...\x1b[0m');
    const deployFiles = await deploymentAgent(callChat, files, expandedTask, projectDir, opts);
    Object.assign(files, deployFiles);
    for (const [fname, fcontent] of Object.entries(deployFiles)) {
      const fp5 = path.join(projectDir, fname);
      fs.mkdirSync(path.dirname(fp5), { recursive: true });
      fs.writeFileSync(fp5, fcontent || '', 'utf-8');
    }

    console.log('\x1b[36m[STEP 12] Continuous Feedback Loop...\x1b[0m');
    for (let feedbackIter = 1; feedbackIter <= maxFeedbackLoops; feedbackIter++) {
      const currentStaticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
      const { files: updatedFiles, done } = await continuousFeedbackAgent(
        callChat,
        files,
        automationTestResults,
        currentStaticIssues,
        securityResult,
        uxResult,
        userSimResult,
        expandedTask,
        feedbackIter,
        opts
      );
      files = updatedFiles;
      for (const [fname, fcontent] of Object.entries(files)) {
        if (fname === '_automation.js') continue;
        const fp6 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp6), { recursive: true });
        fs.writeFileSync(fp6, fcontent || '', 'utf-8');
      }
      if (done) break;
    }

    const finalStaticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
    const remainingImgIssues = finalStaticIssues.filter(i => i.type?.includes('asset'));
    if (remainingImgIssues.length > 0) {
      console.warn(`\x1b[33m[FINAL] ${remainingImgIssues.length} asset issues remain — forcing SVG replacement\x1b[0m`);
      files = await debuggingAgent(callChat, files, remainingImgIssues.map(i => `[ASSET] ${i.file}: ${i.match || i.ref} — REPLACE WITH INLINE SVG`), expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        if (fname === '_automation.js') continue;
        const fp7 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp7), { recursive: true });
        fs.writeFileSync(fp7, fcontent || '', 'utf-8');
      }
    }

    console.log('\x1b[36m[FINAL] Extracting artifacts...\x1b[0m');
    const finalFilesMap = {};
    for (const [fname] of Object.entries(files)) {
      const parts = fname.split(/[/\\]/);
      if (parts.some(p => excluded.has(p))) continue;
      if (excluded1.has(path.basename(fname))) continue;
      const finalPath = path.join(projectDir, fname);
      if (fs.existsSync(finalPath)) {
        try {
          finalFilesMap[fname] = fs.readFileSync(finalPath, 'utf-8');
        } catch {}
      }
    }
    safeRmSync(projectDir);
    console.log('\x1b[32m[FINAL] All 14 pipeline steps complete. Ephemeral sandbox wiped.\x1b[0m');
    return {
      files: finalFilesMap,
      buildCommands: buildCmds || 'npm install',
      runCommands: runCmds,
      success: true,
      automationResults: automationTestResults,
    };
  } catch (e) {
    safeRmSync(projectDir);
    console.error(`\x1b[31m[CRITICAL] generateAndRunProject failed:\x1b[0m ${e.message}\n${e.stack}`);
    return { success: false, error: e.message };
  }
}

export {
  generateAndRunCode,
  generateAndRunProject,
  runMCTSApproaches,
  compareResults,
  runJSSandbox,
  runPythonSandbox,
  sympyEquality,
  architectureAgent,
  requirementExpanderAgent,
  uxDesignAgent,
  securityPerformanceAgent,
  userSimulationAgent,
  testGenerationAgent,
  deploymentAgent,
  fetchPackageDocumentation,
  extractPackageList,
  generateAutomationScript,
  staticAnalysisAgent,
  debuggingAgent,
  continuousFeedbackAgent,
  detectExternalImages,
  detectBrokenLinks,
  PYTHON_BIN,
};
