// codeGenerator/sandbox.ts
// isolated-vm for JS, subprocess fallback for python. the python path is
// best-effort — the import blocklist covers the obvious exfil vectors.
import ivm from 'isolated-vm';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const sandbox = 20_000;
export const tmpSuffix = (): string => `${Date.now()}_${Math.random().toString(36).slice(2)}`;

const BLOCKED = new Set(['child_process', 'fs', 'net', 'crypto', 'vm', 'inspector']);

function isPythonAvailable(): string | null {
  for (const bin of ['python3', 'python']) {
    try {
      execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
      return bin;
    } catch { /* ignore */ }
  }
  return null;
}

export const PYTHON_BIN: string | null = isPythonAvailable();

export async function runJSSandbox(code: string): Promise<string> {
  const isolate = new ivm.Isolate({ memoryLimit: 32 });
  const jail = isolate.createContextSync();
  let stdout = '';
  const log = (...args: unknown[]): void => { stdout += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'; };
  const ref = jail.global.set('global', jail.global.derefInto({}));
  await jail.global.set('console', { log: new ivm.Callback((...args: unknown[]) => log(...args)) }, { copy: true });
  await jail.global.set('process', { stdout: { write: new ivm.Callback((s: unknown) => { stdout += String(s); }) } }, { copy: true });
  await jail.global.set('require', new ivm.Callback((mod: string) => {
    if (BLOCKED.has(mod)) throw new Error(`"${mod}" blocked in sandbox`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(mod);
  }), { reference: true });
  const wrapped = `(async () => {\n${code}\n})();`;
  let script: ivm.Script;
  try {
    script = isolate.compileScriptSync(wrapped, { filename: 'user.js' });
  } catch (e) {
    isolate.dispose();
    throw new Error(`compile: ${(e as Error).message}`);
  }
  let timer: NodeJS.Timeout | undefined;
  let cpuLogger: NodeJS.Timeout | undefined;
  let disposed = false;
  try {
    cpuLogger = setInterval(() => {
      if (disposed) return;
      try {
        const stats = isolate.getHeapStatisticsSync();
        if (stats.used_heap_size > 30 * 1024 * 1024) {
          disposed = true;
          try { isolate.dispose(); } catch { /* ignore */ }
        }
      } catch { /* isolate already gone */ }
    }, 1000);
    timer = setTimeout(() => {
      disposed = true;
      try { isolate.dispose(); } catch { /* ignore */ }
    }, sandbox);
    const result = await script.run(jail, { reference: true, timeout: sandbox, promise: true });
    if (result && typeof result === 'object' && typeof (result as any).copy === 'function') {
      // isolate ref — pull it across the boundary
      try {
        const v = await (result as any).copy();
        if (v === undefined) return stdout.replace(/\n$/, '');
        if (typeof v === 'string') return stdout + v;
        return stdout + JSON.stringify(v);
      } catch { return stdout.replace(/\n$/, '') + '[unserializable]'; }
    }
    return stdout.replace(/\n$/, '') + (result !== undefined ? String(result) : '');
  } finally {
    if (timer) clearTimeout(timer);
    if (cpuLogger) clearInterval(cpuLogger);
    if (!disposed) {
      try { isolate.dispose(); } catch { /* ignore */ }
    }
  }
}

export function runPythonSandbox(code: string): Promise<string> {
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
    const proc = spawn(PYTHON_BIN, ['-I', tmp], { env: { PATH: process.env.PATH || '' } });
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`Python timeout after ${sandbox / 1000}s`)); }, sandbox);
    proc.on('close', code => {
      clearTimeout(t);
      fs.unlink(tmp, () => {});
      code !== 0 ? reject(new Error((err || `Exit ${code}`).trim())) : resolve(out.trim());
    });
  });
}
