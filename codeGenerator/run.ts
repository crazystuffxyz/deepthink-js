// codeGenerator/run.ts
// full project generator pipeline (12 steps + automation + feedback).
import { exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFetchResults, getSearchResults } from '../internet/interactWithInternet.js';
import { FILE_BLOCK_PROMPT, parseFilesFromResponse, applyPatchBlocks, checkSyntaxAST, detectExternalImages, detectBrokenLinks, generateAutomationScript } from './fileBlocks.js';
import { tmpSuffix } from './sandbox.js';
import { compareResults, runMCTSApproaches } from './python.js';
import { log } from '../thinking/events.js';

export { compareResults };

const excluded = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.cache', '.npm', 'dist', 'build', '.git']);
const excluded1 = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'Pipfile.lock']);

function safeRmSync(dir: string): void {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { log({ level: 'warn', source: 'codeGenerator', msg: `[CLEANUP] Could not remove ${dir}: ${(e as Error).message}` }); }
}

export async function fetchPackageDocumentation(callChat: any, packageNames: string[], opts: any = {}): Promise<Record<string, string>> {
  if (!packageNames || packageNames.length === 0) return {};
  log({ level: 'info', source: 'codeGenerator', msg: `[PKG DOCS] Fetching documentation for ${packageNames.length} packages: ${packageNames.join(', ')}` });
  const docs: Record<string, string> = {};
  for (const pkg of packageNames) {
    const npmUrl = `https://www.npmjs.com/package/${pkg}`;
    let docText = '';
    let searchContext = '';
    try {
      docText = await getFetchResults(npmUrl);
      if (!docText || docText.startsWith('Error:') || docText.length < 100) {
        log({ level: 'warn', source: 'codeGenerator', msg: `[PKG DOCS] npm page fetch failed for ${pkg}, trying search` });
        const results = await getSearchResults(`${pkg} npm package documentation usage examples`, opts);
        if (results && results.length > 0) searchContext = results.slice(0, 3).map((r: any) => `${r.title}: ${r.snippet}`).join('\n');
      }
    } catch (e) {
      log({ level: 'warn', source: 'codeGenerator', msg: `[PKG DOCS] Fetch error for ${pkg}: ${(e as Error).message}` });
      try {
        const results = await getSearchResults(`${pkg} npm usage api examples`, opts);
        if (results && results.length > 0) searchContext = results.slice(0, 3).map((r: any) => `${r.title}: ${r.snippet}`).join('\n');
      } catch { /* ignore */ }
    }
    const combined = [docText, searchContext].filter(Boolean).join('\n\n');
    if (combined.length > 50) {
      try {
        const r = await callChat(
          [{ role: 'system', content: 'Extract key API usage, imports, constructor signatures, and example code from this npm package documentation. Output only a concise technical reference — installation command, import style, key functions with signatures, and 1-2 code examples. Max 400 words.' },
           { role: 'user', content: `Package: ${pkg}\n\nDocs:\n${combined.slice(0, 6000)}` }],
          false, null, { ...opts, think: false, samplingProfile: 'json' }
        );
        docs[pkg] = (r.content || '').trim();
      } catch {
        docs[pkg] = combined.slice(0, 400);
      }
    } else {
      docs[pkg] = `Package: ${pkg} — documentation unavailable, use standard API patterns.`;
    }
    log({ level: 'info', source: 'codeGenerator', msg: `[PKG DOCS] ${pkg}: ${docs[pkg].length} chars of documentation` });
  }
  return docs;
}

export async function extractPackageList(callChat: any, task: string, requirementsSpec: any, opts: any = {}): Promise<{ dependencies: string[]; devDependencies: string[] }> {
  const r = await callChat(
    [{ role: 'system', content:
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
    }, { role: 'user', content: `Task: ${task}\n\nSpec: ${JSON.stringify(requirementsSpec, null, 2)}` }],
    false, null, { ...opts, think: false, samplingProfile: 'json' }
  );
  try {
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { dependencies: [], devDependencies: [] };
  }
}

async function requirementExpanderAgent(callChat: any, task: string, opts: any): Promise<any> {
  log({ level: 'info', source: 'codeGenerator', msg: '[STEP 1] Expanding requirements from vague prompt...' });
  const r = await callChat(
    [{ role: 'system', content:
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
    }, { role: 'user', content: `User prompt: ${task}` }],
    false, null, { ...opts, think: false, samplingProfile: 'json' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const spec = JSON.parse(jsonStr);
     log({ level: 'info', source: 'codeGenerator', msg: `[STEP 1] Features: ${spec.coreFeatures?.length ?? 0} core, ${spec.impliedFeatures?.length ?? 0} implied` });
    return spec;
  } catch {
     log({ level: 'warn', source: 'codeGenerator', msg: '[STEP 1] JSON parse failed — using raw task' });
    return {
      expandedSpec: task, targetAudience: 'general users', coreFeatures: [], impliedFeatures: [],
      techConstraints: ['Node.js backend', 'SVG-only graphics', 'fullstack'],
      stackDecision: 'Express.js + EJS + vanilla JS', outOfScope: [],
    };
  }
}

async function architectureAgent(callChat: any, task: string, requirementsSpec: any, packageDocs: Record<string, string>, opts: any): Promise<any> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 2] Architecture planning...' });
  const docsBlock = Object.keys(packageDocs).length
    ? `\nAvailable package documentation:\n${Object.entries(packageDocs).map(([k, v]) => `${k}:\n${v}`).join('\n\n---\n\n')}`
    : '';
  const r = await callChat(
    [{ role: 'system', content:
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
    }, { role: 'user', content: `Task: ${task}\n\nSpec: ${JSON.stringify(requirementsSpec, null, 2)}${docsBlock}` }],
    false, null, { ...opts, think: true, samplingProfile: 'planning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const arch = JSON.parse(jsonStr);
     log({ level: 'info', source: 'codeGenerator', msg: `[STEP 2] Architecture: ${arch.folderStructure?.length ?? 0} files planned, ${arch.tasksForWorkers?.length ?? 0} worker tasks` });
    return arch;
  } catch {
     log({ level: 'warn', source: 'codeGenerator', msg: '[STEP 2] Architecture parse failed — using defaults' });
    return {
      folderStructure: ['server.js', 'package.json', 'public/index.html', 'public/style.css', 'public/app.js'],
      entryPoint: 'server.js', apiRoutes: [], frontendPages: ['public/index.html'],
      stateManagement: 'server-side sessions', databaseStrategy: 'JSON file storage',
      authStrategy: 'none', performanceStrategy: 'static file serving',
      tasksForWorkers: [
        { id: 1, label: 'Backend', files: ['server.js', 'package.json'], description: 'Express server and API' },
        { id: 2, label: 'Frontend', files: ['public/index.html', 'public/style.css', 'public/app.js'], description: 'UI pages' },
      ],
    };
  }
}

async function projectManagerAgent(callChat: any, task: string, architecture: any, requirementsSpec: any, opts: any): Promise<any> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 3] Project Manager — breaking into worker tasks...' });
  const r = await callChat(
    [{ role: 'system', content:
        'You are a Strategic Project Manager and Technical Lead. Your goal is to translate a high-level architecture into a high-precision, dependency-aware execution roadmap.\n\n' +
        'SPRINT PLANNING PROTOCOL:\n' +
        '  1. Atomic Decomposition: Break the architecture into the smallest possible functional units (tickets). Each ticket must be a "complete" deliverable.\n' +
        '  2. Dependency Sequencing: Explicitly map the critical path. No ticket should be "ready" if its data dependencies (e.g., API contracts) are not yet defined.\n' +
        '  3. Ownership Specialization: Assign each ticket to a specific lens: "backend" (API/Logic), "frontend" (UI/UX), "database" (Persistence/Schema), "auth" (Security/Identity), or "testing" (Verification).\n' +
        '  4. Acceptance Rigor: Define binary "Pass/Fail" criteria for every ticket. Vague goals like "implement login" are forbidden; use "POST /auth/login returns JWT on valid creds".\n\n' +
        'Output ONLY valid JSON — no markdown fences:\n' +
        '{\n' +
        '  "tickets": [\n' +
        '    {"id": 1, "title": "Setup Express server", "owner": "backend", "priority": "critical", "files": ["server.js", "package.json"], "dependsOn": [], "acceptanceCriteria": ["server starts on port 3000", "GET / returns 200"]}\n' +
        '  ]\n' +
        '}',
    }, { role: 'user', content: `Task: ${task}\n\nArchitecture:\n${JSON.stringify(architecture, null, 2)}\n\nSpec:\n${JSON.stringify(requirementsSpec, null, 2)}` }],
    false, null, { ...opts, think: false, samplingProfile: 'planning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const pm = JSON.parse(jsonStr);
     log({ level: 'info', source: 'codeGenerator', msg: `[STEP 3] PM: ${pm.tickets?.length ?? 0} sprint tickets created` });
    return pm;
  } catch {
    return { tickets: architecture.tasksForWorkers || [] };
  }
}

async function coderWorkerAgent(callChat: any, task: string, ticket: any, existingFiles: Record<string, string>, architecture: any, requirementsSpec: any, packageDocs: Record<string, string>, opts: any): Promise<Record<string, string>> {
  const owner = ticket.owner || ticket.label || 'coder';
log({ level: 'info', source: 'codeGenerator', msg: `[STEP 4] Coder Worker [${owner}] — ticket: ${ticket.title || ticket.label}` });
  const existingContext = Object.entries(existingFiles)
    .filter(([f]) => ticket.files ? ticket.files.some((tf: string) => f.includes(path.basename(tf))) : true)
    .map(([f, c]) => `\n// ${f}\n${(c || '').slice(0, 2000)}\n`)
    .join('\n\n');
  const docsBlock = Object.keys(packageDocs).length
    ? `\nPackage documentation for reference:\n${Object.entries(packageDocs).map(([k, v]) => `${k}: ${v.slice(0, 300)}`).join('\n---\n')}\n`
    : '';
  const r = await callChat(
    [{ role: 'system', content:
        `You are a Senior ${owner} Engineer operating under a "Zero-Defect" mandate. Your goal is to implement your assigned ticket with maximum technical rigor and absolute adherence to the provided specification.\n\n` +
        `IMPLEMENTATION PROTOCOLS:\n` +
        `  1. Specification Literalism: Implement exactly what is in the ticket and architecture. Do NOT add "extra" features or "improve" the spec without explicit instruction.\n` +
        `  2. Interface Contract Adherence: If the architecture defines an API endpoint as POST /api/user, use exactly that path and method. No variations.\n` +
        `  3. Pure Inline Assets: Every single icon or graphic must be a hand-crafted inline SVG. NO external URLs, NO base64.\n` +
        `  4. Dependency Transparency: Use only the approved npm packages. If you need a new one, it must be justified in the output.\n` +
        `  5. Completeness Guarantee: No "// ...", no "TODO", no placeholders. Every file must be production-ready and runnable.\n\n` +
        `${FILE_BLOCK_PROMPT}\n\n` +
        `CRITICAL RULES:\n` +
        `  - Stack: Node.js + Express.js (backend), static HTML/CSS/JS or EJS (frontend)\n` +
        `  - ALL icons and graphics MUST be inline SVG — never use external URLs for icons\n` +
        `  - NEVER reference external image URLs (no unsplash, no placeholder.com, no lorempixel)\n` +
        `  - NEVER use base64 image data in code — use SVG elements only\n` +
        `  - NEVER use broken relative paths — all static assets served from /public/\n` +
        `  - All href links in HTML must point to actual files in the project\n` +
        `  - package.json must use "type": "commonjs" unless ESM explicitly needed\n` +
        `  - Use require() not import for backend unless package.json has "type":"module"\n` +
        `  - CSS animations and transitions are fine; never use @import for external fonts without fallback\n` +
        `  - Database file paths must use path.join(__dirname, ...) for portability\n` +
        `  - No TODO comments, no placeholder logic — ALL code must be complete and functional\n` +
        `${docsBlock}`,
    }, { role: 'user', content:
        `Overall task: ${task}\n\n` +
        `Your ticket:\n${JSON.stringify(ticket, null, 2)}\n\n` +
        `Architecture context:\n${JSON.stringify(architecture, null, 2)}\n\n` +
        `Spec:\n${JSON.stringify(requirementsSpec, null, 2)}\n\n` +
        (existingContext ? `Existing files for context:\n${existingContext}\n\n` : '') +
        `Generate all files for this ticket now:` }],
    false, null, { ...opts, think: true, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let newFiles = parseFilesFromResponse(responseContent);
  newFiles = applyPatchBlocks(responseContent, { ...existingFiles, ...newFiles });
  const onlyNew: Record<string, string> = {};
  for (const [k, v] of Object.entries(newFiles)) {
    if (!(k in existingFiles) || newFiles[k] !== existingFiles[k]) onlyNew[k] = v;
  }
  log({ level: 'info', source: 'codeGenerator', msg: `[STEP 4] Worker [${owner}] produced: ${Object.keys(onlyNew).join(', ') || 'no new files'}` });
  return onlyNew;
}

export async function staticAnalysisAgent(_callChat: any, files: Record<string, string>, _task: string, _opts: any): Promise<Array<{ file: string; type: string; error?: string; ref?: string; match?: string }>> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 5] Static Analysis — linting and syntax checking...' });
  const issues: Array<{ file: string; type: string; error?: string; ref?: string; match?: string }> = [];
  for (const [fname, content] of Object.entries(files)) {
    const ext = path.extname(fname).toLowerCase();
    const tmp = path.join(os.tmpdir(), `lint_${tmpSuffix()}${ext}`);
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const r = checkSyntaxAST(tmp);
        if (!r.valid) issues.push({ file: fname, type: 'syntax', error: r.error ?? 'unknown' });
      }
    } catch (e) {
      issues.push({ file: fname, type: 'write_error', error: (e as Error).message });
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  const imgIssues = detectExternalImages(files);
  const linkIssues = detectBrokenLinks(files);
  issues.push(...imgIssues.map(i => ({ ...i, type: `asset_${i.type}` })));
  issues.push(...linkIssues.map(i => ({ ...i, type: `link_${i.type}` })));
  if (issues.length > 0) {
     log({ level: 'warn', source: 'codeGenerator', msg: `[STEP 5] Static analysis found ${issues.length} issues` });
  } else {
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 5] Static analysis passed' });
  }
  return issues;
}

async function testGenerationAgent(callChat: any, files: Record<string, string>, task: string, architecture: any, opts: any): Promise<{ testFile: string; testCode: string } | null> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 6] Test Generation — unit + integration + edge case tests...' });
  const filesSummary = Object.entries(files).map(([f, c]) => `// FILE: ${f}\n${(c || '').slice(0, 1500)}`).join('\n\n---\n\n');
  const apiRoutes = (Array.isArray(architecture.apiRoutes) ? architecture.apiRoutes : []).map((r: any) => `${r.method || 'GET'} ${r.path || '/'}: ${r.description || ''}`).join('\n');
  const r = await callChat(
    [{ role: 'system', content:
        `You are a Test Engineer. Generate a comprehensive test suite.\n\n` +
        `${FILE_BLOCK_PROMPT}\n\n` +
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
    }, { role: 'user', content:
        `Task: ${task}\n\nAPI Routes:\n${apiRoutes || '(none detected)'}\n\nCode:\n${filesSummary}\n\nGenerate comprehensive tests:` }],
    false, null, { ...opts, think: false, samplingProfile: 'code' }
  );
  const testFiles = parseFilesFromResponse(r.content || '');
  const testEntry = Object.keys(testFiles)[0];
  if (!testEntry) {
    const raw = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    if (raw.length > 10) return { testFile: '_tests.js', testCode: raw };
    return null;
  }
  return { testFile: testEntry, testCode: testFiles[testEntry] };
}

async function debuggingAgent(callChat: any, files: Record<string, string>, errorLog: string[], task: string, opts: any): Promise<Record<string, string>> {
log({ level: 'info', source: 'codeGenerator', msg: `[STEP 7] Debugging Agent — analyzing ${errorLog.length} errors...` });
  const currentFilesBlock = Object.entries(files).map(([fname, code]) => `\n${(code || '').slice(0, 3000)}\n`).join('\n\n');
  const r = await callChat(
    [{ role: 'system', content:
        `You are a Forensic Debugging Engineer. Your goal is to eliminate the provided errors by performing a root-cause analysis of the project state.\n\n${FILE_BLOCK_PROMPT}\n\n` +
        `REPAIR PROTOCOLS:\n` +
        `  1. Root Cause Isolation: Distinguish between "Symptom Errors" (e.g., 500 Internal Server Error) and "Root Cause Errors" (e.g., undefined variable in line 42).\n` +
        `  2. Path Integrity Audit: If a "Module Not Found" error occurs, verify the exact relative path against the architecture's folder structure.\n` +
        `  3. Asset Purge: If any asset issue is detected, immediately replace the offending tag with a professional inline SVG. No exceptions.\n` +
        `  4. Hallucination Correction: If a non-existent npm package was used, rewrite the logic using Node.js standard library or a verified alternative.\n` +
        `  5. Minimal Surface Area: Only output the files that MUST change. Do not rewrite stable code.\n` +
        `  6. Precision Patching: Use ### PATCH: for localized fixes to preserve the surrounding logic.`,
    }, { role: 'user', content:
        `Task: ${task}\n\n` +
        `Errors to fix:\n${errorLog.join('\n')}\n\n` +
        `Current files:\n${currentFilesBlock}\n\n` +
        `Output corrected files:` }],
    false, null, { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles: Record<string, string> = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return updatedFiles;
}

async function uxDesignAgent(callChat: any, files: Record<string, string>, task: string, requirementsSpec: any, opts: any): Promise<any> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 8] UX/Design Agent — reviewing and improving aesthetics...' });
  const htmlCssFiles = Object.entries(files)
    .filter(([f]) => f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.ejs'))
    .map(([f, c]) => `\n// FILE: ${f}\n${(c || '').slice(0, 3000)}\n`)
    .join('\n\n');
  if (!htmlCssFiles) return null;
  const audience = requirementsSpec?.targetAudience || 'general users';
  const r = await callChat(
    [{ role: 'system', content:
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
    }, { role: 'user', content: `Task: ${task}\n\nFrontend files:\n${htmlCssFiles}\n\nUX review:` }],
    false, null, { ...opts, think: false, samplingProfile: 'reasoning' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const result = JSON.parse(jsonStr);
     log({ level: 'info', source: 'codeGenerator', msg: `[STEP 8] UX: ${result.issues?.length ?? 0} issues, ${result.suggestions?.length ?? 0} suggestions, score=${result.score ?? 'N/A'}` });
    return result;
  } catch { return null; }
}

async function securityPerformanceAgent(callChat: any, files: Record<string, string>, task: string, opts: any): Promise<any> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 9] Security + Performance Review...' });
  const filesSummary = Object.entries(files).map(([f, c]) => `\n// ${f}\n${(c || '').slice(0, 2000)}\n`).join('\n\n');
  const r = await callChat(
    [{ role: 'system', content:
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
    }, { role: 'user', content: `Task: ${task}\n\nFiles:\n${filesSummary}\n\nSecurity and performance audit:` }],
    false, null, { ...opts, think: false, samplingProfile: 'verify' }
  );
  try {
    const raw = (r.content || '').trim();
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
    const result = JSON.parse(jsonStr);
    const criticalCount = result.criticalIssues?.length ?? 0;
     log({ level: 'info', source: 'codeGenerator', msg: `[STEP 9] Security: ${criticalCount} critical | sec=${result.securityScore ?? 'N/A'} perf=${result.performanceScore ?? 'N/A'}` });
    return result;
  } catch { return null; }
}

async function deploymentAgent(callChat: any, files: Record<string, string>, task: string, _projectDir: string, opts: any): Promise<Record<string, string>> {
log({ level: 'info', source: 'codeGenerator', msg: '[STEP 11] Deployment Agent — generating deployment scripts...' });
  const fileList = Object.keys(files).join(', ');
  const r = await callChat(
    [{ role: 'system', content:
        'You are a Lead DevOps Engineer. Your goal is to create a production-ready deployment package that ensures the project is portable, secure, and easily deployable.\n\n' +
        `${FILE_BLOCK_PROMPT}\n\n` +
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
    }, { role: 'user', content: `Task: ${task}\n\nProject files: ${fileList}\n\nGenerate deployment artifacts:` }],
    false, null, { ...opts, think: false, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  const deployFiles = parseFilesFromResponse(responseContent);
log({ level: 'info', source: 'codeGenerator', msg: `[STEP 11] Deployment: generated ${Object.keys(deployFiles).join(', ')}` });
  return deployFiles;
}

async function continuousFeedbackAgent(callChat: any, files: Record<string, string>, testResults: any, staticIssues: any[], securityResult: any, uxResult: any, userSimResult: any, task: string, iterationNumber: number, opts: any): Promise<{ files: Record<string, string>; done: boolean }> {
log({ level: 'info', source: 'codeGenerator', msg: `[STEP 12/FEEDBACK] Continuous feedback loop — iteration ${iterationNumber}...` });
  const allIssues: string[] = [];
  if (staticIssues && staticIssues.length > 0) allIssues.push(...staticIssues.map((i: any) => `[STATIC/${i.type?.toUpperCase()}] ${i.file}: ${i.error || i.ref || i.match}`));
  if (securityResult?.criticalIssues?.length) for (const issue of securityResult.criticalIssues) allIssues.push(`[SECURITY/${issue.type?.toUpperCase() ?? 'CRITICAL'}] ${issue.file}: ${issue.description} — Fix: ${issue.fix}`);
  if (uxResult?.issues?.length) for (const issue of uxResult.issues) allIssues.push(`[UX] ${issue}`);
  if (userSimResult?.topBlockers?.length) for (const blocker of userSimResult.topBlockers) allIssues.push(`[USER_SIM_BLOCKER] ${blocker}`);
  if (testResults?.failed > 0 && testResults?.errors?.length) for (const err of testResults.errors) allIssues.push(`[TEST_FAIL] ${err}`);
  if (allIssues.length === 0) {
     log({ level: 'info', source: 'codeGenerator', msg: '[FEEDBACK] No issues remaining — project is ready' });
    return { files, done: true };
  }
log({ level: 'info', source: 'codeGenerator', msg: `[FEEDBACK] ${allIssues.length} issues to fix in iteration ${iterationNumber}` });
  const currentFilesBlock = Object.entries(files).map(([fname, code]) => `\n${(code || '').slice(0, 2000)}\n`).join('\n\n');
  const r = await callChat(
    [{ role: 'system', content:
        `You are a Continuous Improvement Agent (iteration ${iterationNumber}). Fix ALL listed issues.\n\n${FILE_BLOCK_PROMPT}\n\n` +
        `CRITICAL RULES:\n` +
        `  - Replace ALL external image URLs with inline SVG placeholders\n` +
        `  - Replace ALL base64 images with inline SVG\n` +
        `  - Fix ALL broken relative paths\n` +
        `  - Fix ALL security issues\n` +
        `  - Fix ALL failing tests\n` +
        `  - Output ONLY files that changed — do NOT re-output unchanged files`,
    }, { role: 'user', content:
        `Issues to fix (iteration ${iterationNumber}):\n${allIssues.map((i, n) => `${n + 1}. ${i}`).join('\n')}\n\n` +
        `Current files:\n${currentFilesBlock}\n\nOutput corrected files:` }],
    false, null, { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles: Record<string, string> = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return { files: updatedFiles, done: false };
}

async function runFullAutomationTests(projectDir: string, entryPoint: string, files: Record<string, string>, architecture: any, task: string, _buildCmds: string, _runCmds: string): Promise<{ passed: number; failed: number; errors: string[]; warnings: string[] }> {
  const automationScript = generateAutomationScript(files, architecture, task);
  const automationPath = path.join(projectDir, '_automation.js');
  fs.writeFileSync(automationPath, automationScript, 'utf-8');
  let serverProc: any = null;
  const results = { passed: 0, failed: 0, errors: [] as string[], warnings: [] as string[] };
  try {
    const startCmd = `node ${entryPoint}`.split(' ');
    serverProc = spawn(startCmd[0], startCmd.slice(1), {
      cwd: projectDir,
      env: { ...process.env, PORT: '3000', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString();
      if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed')) results.errors.push(`SERVER STDERR: ${msg.trim()}`);
    });
    await new Promise(r => setTimeout(r, 3000));
    const testOutput = await new Promise<{ out: string; err: string; exitCode: number | null }>((resolve) => {
      let out = '', err = '';
      const testProc = spawn(process.execPath, ['_automation.js'], { cwd: projectDir, env: { ...process.env, PORT: '3000' }, timeout: 60000 });
      testProc.stdout.on('data', c => { out += c; process.stdout.write(c); });
      testProc.stderr.on('data', c => { err += c; });
      const t = setTimeout(() => { testProc.kill('SIGKILL'); }, 60000);
      testProc.on('close', code => { clearTimeout(t); resolve({ out, err, exitCode: code }); });
    });
    const passMatch = testOutput.out.match(/Passed:\s*(\d+)/);
    const failMatch = testOutput.out.match(/Failed:\s*(\d+)/);
    if (passMatch) results.passed = parseInt(passMatch[1]);
    if (failMatch) results.failed = parseInt(failMatch[1]);
    const failLines = testOutput.out.split('\n').filter(l => l.trim().startsWith('✗') || l.includes('FAIL [') || l.includes('TESTS FAILED'));
    results.errors.push(...failLines);
    if (testOutput.err) results.errors.push(`TEST RUNNER STDERR: ${testOutput.err.slice(0, 500)}`);
     log({ level: 'info', source: 'codeGenerator', msg: `[AUTOMATION] Results: ${results.passed} passed, ${results.failed} failed` });
  } catch (e) {
    results.errors.push(`Automation runner error: ${(e as Error).message}`);
     log({ level: 'warn', source: 'codeGenerator', msg: `[AUTOMATION] Runner error: ${(e as Error).message}` });
  } finally {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
  }
  return results;
}

async function oracleFixLoop(callChat: any, files: Record<string, string>, oracleTrace: string, opts: any): Promise<Record<string, string>> {
  const currentFilesBlock = Object.entries(files).map(([fname, code]) => `\n${(code || '').slice(0, 2000)}\n`).join('\n\n');
  const r = await callChat(
    [{ role: 'system', content:
        `You are a test-failure repair engine. Fix the code so all tests pass.\n\n${FILE_BLOCK_PROMPT}\n\n` +
        `REPAIR RULES:\n` +
        `  - Output ONLY files that need changes.\n` +
        `  - Use ### PATCH: for small targeted changes, ### FILE: for full rewrites.\n` +
        `  - Do NOT modify _tests.js or _automation.js unless they are factually wrong.\n` +
        `  - Fix the implementation to match the test expectations.\n` +
        `  - For 404 failures: add missing routes to server.js\n` +
        `  - For 500 failures: add error handling and input validation\n` +
        `  - For asset issues: replace with inline SVG`,
    }, { role: 'user', content:
        `Current files:\n\n${currentFilesBlock}\n\n` +
        `Test failures:\n${oracleTrace}\n\n` +
        `Output corrected files:` }],
    false, null, { ...opts, samplingProfile: 'code' }
  );
  const responseContent = r.content || '';
  let updatedFiles: Record<string, string> = { ...files };
  updatedFiles = applyPatchBlocks(responseContent, updatedFiles);
  const newFiles = parseFilesFromResponse(responseContent);
  if (Object.keys(newFiles).length > 0) Object.assign(updatedFiles, newFiles);
  return updatedFiles;
}

// one cheap call that decides how deep the pipeline goes. a single-file
// "hello world" must not pay for package docs + architecture + PM + UX +
// security + deployment agents (6-8 wasted LLM calls). only "large" tasks
// get the full 12-step treatment.
export async function classifyTaskComplexity(callChat: any, task: string, opts: any = {}): Promise<{ level: 'small' | 'medium' | 'large'; backend: boolean; frontend: boolean; packages: string[]; reason: string }> {
  try {
    const r = await callChat(
      [{ role: 'system', content:
        'You are a project complexity classifier for a Node.js code generator.\n' +
        'Classify the task into exactly one of:\n' +
        '  - "small": single file / single page / trivial UI component / simple script. No backend, no database, no auth, no state.\n' +
        '  - "medium": multi-file app, OR a backend API, OR a database, OR moderate interactivity. Not deployment-grade.\n' +
        '  - "large": full-stack app with auth/db/sessions, or many pages + API + persistence, or anything needing production hardening.\n\n' +
        'Also list any npm packages you are CERTAIN the task needs (empty array if none).\n' +
        'Output ONLY valid JSON:\n' +
        '{"level":"small|medium|large","backend":true|false,"frontend":true|false,"packages":["..."],"reason":"one line"}' },
       { role: 'user', content: `Task: ${task}` }],
      false, null, { ...opts, think: false, samplingProfile: 'json' }
    );
    const cleaned = (r.content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const p = JSON.parse(cleaned);
    const level = ['small', 'medium', 'large'].includes(p.level) ? p.level : 'medium';
    return {
      level,
      backend: !!p.backend,
      frontend: !!p.frontend,
      packages: Array.isArray(p.packages) ? p.packages.slice(0, 10) : [],
      reason: String(p.reason || '').slice(0, 120),
    };
  } catch {
    return { level: 'medium', backend: true, frontend: true, packages: [], reason: 'classifier failed — defaulting to medium' };
  }
}

// which steps run, and how many loop iterations each level gets.
// termination caps shrink with complexity: the point is MINIMUM verified
// calls, not maximum polish.
export function pipelinePlan(level: 'small' | 'medium' | 'large'): { expand: boolean; packages: boolean; docs: boolean; architecture: boolean; pm: boolean; ux: boolean; security: boolean; deployment: boolean; maxBugLoops: number; maxOracleLoops: number; maxFeedbackLoops: number } {
  switch (level) {
    case 'small':
      return { expand: true, packages: true, docs: false, architecture: false, pm: false, ux: false, security: false, deployment: false, maxBugLoops: 2, maxOracleLoops: 1, maxFeedbackLoops: 1 };
    case 'medium':
      return { expand: true, packages: true, docs: true, architecture: true, pm: false, ux: false, security: false, deployment: false, maxBugLoops: 4, maxOracleLoops: 2, maxFeedbackLoops: 2 };
    case 'large':
    default:
      return { expand: true, packages: true, docs: true, architecture: true, pm: true, ux: true, security: true, deployment: true, maxBugLoops: 6, maxOracleLoops: 3, maxFeedbackLoops: 3 };
  }
}

export async function generateAndRunProject(callChat: any, task: string, opts: any = {}): Promise<any> {
  const thinkingDepth = opts.thinkingDepth ?? 2;
  const projectDir = path.join(os.tmpdir(), `project_gen_${tmpSuffix()}`);

  try {
    // adaptive gate: pick pipeline depth before spending any generation calls
    let plan: ReturnType<typeof pipelinePlan>;
    if (opts.complexity) {
      plan = pipelinePlan(opts.complexity);
    } else {
      const cls = await classifyTaskComplexity(callChat, task, opts);
      plan = pipelinePlan(cls.level);
      log({ level: 'info', source: 'codeGenerator', msg: `[GATE] complexity=${cls.level} (backend=${cls.backend}, frontend=${cls.frontend}, ${cls.packages.length} pkgs) — ${cls.reason} — plan: ${plan.deployment ? 'full' : plan.architecture ? 'medium' : 'small'} pipeline` });
    }
    const maxBugFixLoops = opts.maxProjectLoops || plan.maxBugLoops;
    const maxOracleLoops = opts.maxOracleLoops || plan.maxOracleLoops;
    const maxFeedbackLoops = opts.maxFeedbackLoops || plan.maxFeedbackLoops;

     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 1] Requirement Expansion...' });
    const requirementsSpec = await requirementExpanderAgent(callChat, task, opts);
    const expandedTask = requirementsSpec.expandedSpec || task;
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 2] Architecture Planning...' });
    const packageList = await extractPackageList(callChat, expandedTask, requirementsSpec, opts);
    const allPackages = [...(packageList.dependencies || []), ...(packageList.devDependencies || [])];
    const packageDocs = plan.docs ? await fetchPackageDocumentation(callChat, allPackages, opts) : {};
    let architecture;
    if (plan.architecture) {
      architecture = await architectureAgent(callChat, expandedTask, requirementsSpec, packageDocs, opts);
    } else {
      log({ level: 'info', source: 'codeGenerator', msg: '[GATE] skipping architecture agent (small/medium pipeline)' });
      architecture = { entryPoint: 'server.js', folderStructure: [], tasksForWorkers: [] };
    }
    let tickets: any[] = [];
    if (plan.pm) {
       log({ level: 'info', source: 'codeGenerator', msg: '[STEP 3] Project Manager — Sprint Tickets...' });
      const projectPlan = await projectManagerAgent(callChat, expandedTask, architecture, requirementsSpec, opts);
      tickets = projectPlan.tickets || architecture.tasksForWorkers || [];
    } else {
      log({ level: 'info', source: 'codeGenerator', msg: '[GATE] skipping project manager (small/medium pipeline)' });
    }
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 4] Coder Workers — parallel file generation...' });
    let files: Record<string, string> = {};
    const workerGroups = [
      tickets.filter((t: any) => (t.owner || t.label || '').toLowerCase().includes('backend') || (t.owner || t.label || '').toLowerCase().includes('server')),
      tickets.filter((t: any) => (t.owner || t.label || '').toLowerCase().includes('frontend') || (t.owner || t.label || '').toLowerCase().includes('ui')),
      tickets.filter((t: any) => (t.owner || t.label || '').toLowerCase().includes('db') || (t.owner || t.label || '').toLowerCase().includes('database') || (t.owner || t.label || '').toLowerCase().includes('auth')),
      tickets.filter((t: any) => !(t.owner || t.label || '').toLowerCase().match(/backend|server|frontend|ui|db|database|auth/)),
    ].filter(g => g.length > 0);
    if (workerGroups.length === 0 && tickets.length === 0) {
      workerGroups.push([{ id: 1, label: 'fullstack', owner: 'fullstack', title: 'Generate complete project', files: architecture.folderStructure || [], description: expandedTask }]);
    }
    for (const group of workerGroups) {
      const groupResults = await Promise.all(
        group.map((ticket: any) =>
          coderWorkerAgent(callChat, expandedTask, ticket, files, architecture, requirementsSpec, packageDocs, opts)
            .catch((e: Error) => { /* eslint-disable-next-line no-console */ log({ level: 'warn', source: 'codeGenerator', msg: `[WORKER] Ticket ${ticket.id} failed: ${e.message}` }); return {}; })
        )
      );
      for (const result of groupResults) Object.assign(files, result);
    }
    if (Object.keys(files).length === 0) {
       log({ level: 'warn', source: 'codeGenerator', msg: '[STEP 4] No files from workers — falling back to single-pass generation' });
      const r = await callChat(
        [{ role: 'system', content: `You are a code generation engine. Generate a complete fullstack Node.js project.\n\n${FILE_BLOCK_PROMPT}\n\n` +
            `CONSTRAINTS:\n  - Node.js + Express.js backend\n  - All graphics must be inline SVG\n  - No external image URLs\n  - Must include package.json` },
         { role: 'user', content: `Task: ${expandedTask}\n\nArchitecture:\n${JSON.stringify(architecture, null, 2)}\n\nGenerate all project files:` }],
        false, null, { ...opts, think: thinkingDepth >= 2, samplingProfile: 'code' }
      );
      files = parseFilesFromResponse(r.content || '');
      files = applyPatchBlocks(r.content || '', files);
    }
    if (!files['package.json']) {
      const deps: Record<string, string> = {};
      for (const pkg of (packageList.dependencies || [])) deps[pkg] = 'latest';
      files['package.json'] = JSON.stringify({
        name: task.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 50),
        version: '1.0.0', description: task,
        main: architecture.entryPoint || 'server.js',
        scripts: { start: `node ${architecture.entryPoint || 'server.js'}`, test: 'node _tests.js' },
        dependencies: { express: '^4.18.0', ...deps },
        devDependencies: {},
      }, null, 2);
    }
    fs.mkdirSync(projectDir, { recursive: true });
    let buildCmds = '';
    const runCmds = `node ${architecture.entryPoint || 'server.js'}`;
    for (const [fname, fcontent] of Object.entries(files)) {
      const filePath = path.join(projectDir, fname);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fcontent || '', 'utf-8');
    }
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 5] Static Analysis...' });
    let staticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 5b] Installing dependencies...' });
    try {
      if (fs.existsSync(path.join(projectDir, 'package.json'))) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('child_process').execSync('npm install', { cwd: projectDir, stdio: 'pipe', timeout: 120_000 });
        buildCmds = 'npm install';
         log({ level: 'info', source: 'codeGenerator', msg: '[STEP 5b] npm install succeeded' });
      }
    } catch (e) {
       log({ level: 'warn', source: 'codeGenerator', msg: `[STEP 5b] npm install failed: ${(e as Error).message.slice(0, 200)}` });
      staticIssues.push({ file: 'package.json', type: 'npm_install_error', error: (e as Error).message.slice(0, 200) });
    }
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 6] Test Generation...' });
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
      if (!chk.valid) { syntaxPassed = false; execErrorMsg += `[Syntax Error in ${fname}]:\n${chk.error}\n\n`; }
    }
    if (!syntaxPassed) {
       log({ level: 'warn', source: 'codeGenerator', msg: '[STEP 5] Syntax errors — routing to debugger' });
      files = await debuggingAgent(callChat, files, [execErrorMsg], expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        const fp2 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp2), { recursive: true });
        fs.writeFileSync(fp2, fcontent || '', 'utf-8');
      }
    }
    for (let bugIter = 1; bugIter <= maxBugFixLoops; bugIter++) {
       log({ level: 'info', source: 'codeGenerator', msg: `[STEP 7] Bug Fix Loop ${bugIter}/${maxBugFixLoops}...` });
      let runtimeErr = '';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('child_process').execSync(`node --check "${path.join(projectDir, architecture.entryPoint || 'server.js')}"`, { stdio: 'pipe' });
      } catch (e) {
        runtimeErr = ((e as any).stderr ? (e as any).stderr.toString() : '') + ((e as Error).message || '');
      }
      const allErrors = [
        ...staticIssues.filter(i => i.type !== 'asset_external_img_tag' && i.type !== 'link_broken_href').map(i => `[${i.type}] ${i.file}: ${i.error || i.ref || ''}`),
        ...(runtimeErr ? [`[RUNTIME] ${runtimeErr.slice(0, 500)}`] : []),
      ];
      if (allErrors.length === 0) {
         log({ level: 'info', source: 'codeGenerator', msg: `[STEP 7] No critical errors on iteration ${bugIter}` });
        break;
      }
      const before = JSON.stringify(files);
      files = await debuggingAgent(callChat, files, allErrors, expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        const fp3 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp3), { recursive: true });
        fs.writeFileSync(fp3, fcontent || '', 'utf-8');
      }
      if (JSON.stringify(files) === before) {
        log({ level: 'warn', source: 'codeGenerator', msg: `[STEP 7] debugger made no changes on iteration ${bugIter} — stopping loop (stuck)` });
        break;
      }
      staticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
    }
    let uxResult = null;
    if (plan.ux) {
       log({ level: 'info', source: 'codeGenerator', msg: '[STEP 8] UX/Design Review...' });
      uxResult = await uxDesignAgent(callChat, files, expandedTask, requirementsSpec, opts);
    }
    let securityResult = null;
    if (plan.security) {
       log({ level: 'info', source: 'codeGenerator', msg: '[STEP 9] Security + Performance Review...' });
      securityResult = await securityPerformanceAgent(callChat, files, expandedTask, opts);
    }
    let automationTestResults = { passed: 0, failed: 0, errors: [] as string[] };
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 10b] Running full automation test suite...' });
    try {
      automationTestResults = await runFullAutomationTests(projectDir, architecture.entryPoint || 'server.js', files, architecture, expandedTask, buildCmds, runCmds);
    } catch (e) {
       log({ level: 'warn', source: 'codeGenerator', msg: `[AUTOMATION] Test run error: ${(e as Error).message}` });
      automationTestResults.errors.push((e as Error).message);
    }
    for (let oracleIter = 0; oracleIter < maxOracleLoops; oracleIter++) {
      if (automationTestResults.failed === 0 && automationTestResults.errors.length === 0) break;
       log({ level: 'info', source: 'codeGenerator', msg: `[STEP 6b] Oracle fix loop ${oracleIter + 1}/${maxOracleLoops}...` });
      files = await oracleFixLoop(callChat, files, automationTestResults.errors.join('\n'), opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        if (fname === '_automation.js') continue;
        const fp4 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp4), { recursive: true });
        fs.writeFileSync(fp4, fcontent || '', 'utf-8');
      }
      try {
        automationTestResults = await runFullAutomationTests(projectDir, architecture.entryPoint || 'server.js', files, architecture, expandedTask, buildCmds, runCmds);
      } catch (e) { automationTestResults.errors.push((e as Error).message); }
    }
    if (plan.deployment) {
       log({ level: 'info', source: 'codeGenerator', msg: '[STEP 11] Deployment Artifacts...' });
      const deployFiles = await deploymentAgent(callChat, files, expandedTask, projectDir, opts);
      Object.assign(files, deployFiles);
      for (const [fname, fcontent] of Object.entries(deployFiles)) {
        const fp5 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp5), { recursive: true });
        fs.writeFileSync(fp5, fcontent || '', 'utf-8');
      }
    }
     log({ level: 'info', source: 'codeGenerator', msg: '[STEP 12] Continuous Feedback Loop...' });
    for (let feedbackIter = 1; feedbackIter <= maxFeedbackLoops; feedbackIter++) {
      const currentStaticIssues = await staticAnalysisAgent(callChat, files, expandedTask, opts);
      const { files: updatedFiles, done } = await continuousFeedbackAgent(callChat, files, automationTestResults, currentStaticIssues, securityResult, uxResult, null, expandedTask, feedbackIter, opts);
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
      log({ level: 'warn', source: 'codeGenerator', msg: `[FINAL] ${remainingImgIssues.length} asset issues remain — forcing SVG replacement` });
      files = await debuggingAgent(callChat, files, remainingImgIssues.map(i => `[ASSET] ${i.file}: ${i.match || i.ref} — REPLACE WITH INLINE SVG`), expandedTask, opts);
      for (const [fname, fcontent] of Object.entries(files)) {
        if (fname === '_automation.js') continue;
        const fp7 = path.join(projectDir, fname);
        fs.mkdirSync(path.dirname(fp7), { recursive: true });
        fs.writeFileSync(fp7, fcontent || '', 'utf-8');
      }
    }
    log({ level: 'info', source: 'codeGenerator', msg: '[FINAL] Extracting artifacts...' });
    const finalFilesMap: Record<string, string> = {};
    for (const [fname] of Object.entries(files)) {
      const parts = fname.split(/[/\\]/);
      if (parts.some(p => excluded.has(p))) continue;
      if (excluded1.has(path.basename(fname))) continue;
      const finalPath = path.join(projectDir, fname);
      if (fs.existsSync(finalPath)) {
        try { finalFilesMap[fname] = fs.readFileSync(finalPath, 'utf-8'); } catch { /* ignore */ }
      }
    }
    safeRmSync(projectDir);
    log({ level: 'info', source: 'codeGenerator', msg: '[FINAL] All 12 pipeline steps complete. Ephemeral sandbox wiped.' });
    return { files: finalFilesMap, buildCommands: buildCmds || 'npm install', runCommands: runCmds, success: true, automationResults: automationTestResults };
  } catch (e) {
    safeRmSync(projectDir);
    log({ level: 'error', source: 'codeGenerator', msg: `[CRITICAL] generateAndRunProject failed: ${(e as Error).message}\n${(e as Error).stack}` });
    return { success: false, error: (e as Error).message };
  }
}
