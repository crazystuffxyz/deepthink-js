import path from 'path';
import { execSync } from 'child_process';
export const FILE_BLOCK_PROMPT = `\
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
export function parseFilesFromResponse(content) {
    const files = {};
    const primaryRegex = /^###\s+FILE:\s+([a-zA-Z0-9_./@-][a-zA-Z0-9_./@\- ]*?)\s*$\s*```[a-z]*\n([\s\S]*?)```/gm;
    let match;
    while ((match = primaryRegex.exec(content)) !== null) {
        const fname = match[1].trim();
        if (fname)
            files[fname] = match[2];
    }
    if (Object.keys(files).length > 0)
        return files;
    const fallbackA = /```(?:\w+)?\n(?:\/\/\s*|#\s*|---\s*)([a-zA-Z0-9_.-]+)\n([\s\S]*?)```/g;
    while ((match = fallbackA.exec(content)) !== null) {
        const fname = match[1].trim();
        if (fname && /\.[a-z]{1,6}$/.test(fname))
            files[fname] = match[2];
    }
    if (Object.keys(files).length > 0)
        return files;
    const fallbackB = /```([a-zA-Z0-9_.-]+\.[a-z]{1,6})\n([\s\S]*?)```/g;
    while ((match = fallbackB.exec(content)) !== null) {
        files[match[1].trim()] = match[2];
    }
    return files;
}
export function applyPatchBlocks(content, files) {
    const patchRegex = /^###\s+PATCH:\s+([a-zA-Z0-9_./@-][a-zA-Z0-9_./@\- ]*?)\s*$\s*---FIND---\s*\n([\s\S]*?)\n---REPLACE---\s*\n([\s\S]*?)\n---END---/gm;
    let match;
    while ((match = patchRegex.exec(content)) !== null) {
        const fname = match[1].trim();
        const findBlock = match[2];
        const replBlock = match[3];
        if (files[fname] && files[fname].includes(findBlock)) {
            files[fname] = files[fname].replace(findBlock, replBlock);
            // eslint-disable-next-line no-console
            console.log(`[PATCH] Applied patch to ${fname}`);
        }
        else if (files[fname]) {
            const trimFind = findBlock.trim();
            if (files[fname].includes(trimFind)) {
                files[fname] = files[fname].replace(trimFind, replBlock.trim());
                // eslint-disable-next-line no-console
                console.log(`[PATCH] Applied trimmed patch to ${fname}`);
            }
            else {
                // eslint-disable-next-line no-console
                console.warn(`[PATCH] FIND block not matched in ${fname} — skipping patch`);
            }
        }
    }
    const legacyRegex = /<<<SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>REPLACE\s+(\S+)/g;
    while ((match = legacyRegex.exec(content)) !== null) {
        const [, searchBlock, replaceBlock, fname] = match;
        if (files[fname] && files[fname].includes(searchBlock.trim())) {
            files[fname] = files[fname].replace(searchBlock.trim(), replaceBlock.trim());
            // eslint-disable-next-line no-console
            console.log(`[PATCH] Applied legacy patch to ${fname}`);
        }
    }
    return files;
}
export function checkSyntaxAST(filePath) {
    try {
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
            execSyncCheck(`node --check "${filePath}"`);
        }
        else if (filePath.endsWith('.py') && process.env.PYTHON_BIN) {
            execSyncCheck(`${process.env.PYTHON_BIN} -m py_compile "${filePath}"`);
        }
        return { valid: true, error: null };
    }
    catch (e) {
        return { valid: false, error: e.stderr ? e.stderr.toString() : e.message };
    }
}
function execSyncCheck(cmd) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    execSync(cmd, { stdio: 'pipe' });
}
export function detectExternalImages(files) {
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
export function detectBrokenLinks(files) {
    const issues = [];
    const hrefRe = /href=["']([^"'#?]+)["']/gi;
    const srcRe = /src=["']([^"']+)["']/gi;
    const allFileNames = new Set(Object.keys(files).map(f => path.basename(f)));
    for (const [fname, content] of Object.entries(files)) {
        if (!fname.endsWith('.html') && !fname.endsWith('.css') && !fname.endsWith('.js'))
            continue;
        let m;
        while ((m = hrefRe.exec(content)) !== null) {
            const href = m[1];
            if (href.startsWith('http') || href.startsWith('mailto') || href.startsWith('#'))
                continue;
            const base = path.basename(href);
            if (base && !allFileNames.has(base) && !href.startsWith('/api/'))
                issues.push({ file: fname, type: 'broken_href', ref: href });
        }
        while ((m = srcRe.exec(content)) !== null) {
            const src = m[1];
            if (src.startsWith('http') || src.startsWith('data:'))
                continue;
            const base = path.basename(src);
            if (base && base.match(/\.(png|jpg|jpeg|gif|webp|ico|bmp)$/i))
                issues.push({ file: fname, type: 'external_or_missing_img_src', ref: src });
        }
    }
    return issues;
}
export function generateAutomationScript(files, architecture, task) {
    const port = 3000;
    const serverWaitRetries = 15;
    const apiRoutes = Array.isArray(architecture?.apiRoutes) ? architecture.apiRoutes : [];
    const htmlPages = Array.isArray(architecture?.frontendPages) ? architecture.frontendPages : ['public/index.html'];
    const routeTests = apiRoutes.map((route, i) => {
        if (typeof route !== 'object' || !route)
            return '';
        const method = (route.method || 'GET').toUpperCase();
        const rpath = route.path || '/';
        if (method === 'GET') {
            return `
  await runTest('Route: ${method} ${rpath}', async () => {
    const res = await httpRequest('${method}', '${rpath}');
    assert(res.statusCode < 500, \`Server error on ${rpath}: \${res.statusCode}\`);
    console.log(\`  ${method} ${rpath} → \${res.statusCode}\`);
  });`;
        }
        else {
            return `
  await runTest('Route: ${method} ${rpath}', async () => {
    const res = await httpRequest('${method}', '${rpath}', {});
    assert(res.statusCode !== 500, \`Server error on ${rpath}: \${res.statusCode}\`);
    console.log(\`  ${method} ${rpath} → \${res.statusCode}\`);
  });`;
        }
    }).join('');
    const pageTests = htmlPages.map((p) => {
        if (typeof p !== 'string')
            return '';
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
    const firstPost = ${JSON.stringify(apiRoutes.find((r) => r.method === 'POST')?.path || '/api/data')};
    const res = await httpRequest('POST', firstPost, {});
    assert(res.statusCode !== 500, \`Server crashed on empty POST body: \${res.statusCode}\`);
    console.log(\`  Empty POST → \${res.statusCode}\`);
  });

  await runTest('Edge: very large payload', async () => {
    const bigData = { data: 'x'.repeat(100000) };
    const firstPost = ${JSON.stringify(apiRoutes.find((r) => r.method === 'POST')?.path || '/api/data')};
    const res = await httpRequest('POST', firstPost, bigData);
    assert(res.statusCode !== 500, \`Server crashed on large payload: \${res.statusCode}\`);
    console.log(\`  Large payload POST → \${res.statusCode}\`);
  });`;
    const allFormSelectors = (() => {
        const selectors = [];
        for (const [fname, content] of Object.entries(files)) {
            if (!fname.endsWith('.html') && !fname.endsWith('.ejs'))
                continue;
            const formRe = /<form[^>]*action=["']([^"']*)["'][^>]*>/gi;
            let m;
            while ((m = formRe.exec(content)) !== null)
                selectors.push(m[1]);
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
