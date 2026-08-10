// codeGenerator/python.ts
// MCTS-of-approaches + JS+Python double-checked computation.
import { stripCodeFences } from '../thinking/dataTypes.js';
import { runPythonSandbox, runJSSandbox, PYTHON_BIN } from './sandbox.js';

export { PYTHON_BIN };

const MATH_DOMAINS = [
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

export function compareResults(a: string | number | null, b: string | number | null): boolean {
  const norm = (s: string | number | null): number | string => {
    let t = String(s ?? '').trim().replace(/^(?:Integer|Float)\((.+)\)$/, '$1').trim();
    const frac = t.match(/^(-?\d+)\/(-?\d+)$/);
    if (frac) return Number(frac[1]) / Number(frac[2]);
    const n = Number(t.replace(/[$,%\s]/g, ''));
    return isNaN(n) ? t.toLowerCase() : n;
  };
  const na = norm(a), nb = norm(b);
  if (typeof na === 'number' && typeof nb === 'number') {
    return Math.abs(na - nb) / Math.max(Math.abs(na), Math.abs(nb), 1) < 1e-9;
  }
  return na === nb;
}

export async function mathematicianAgent(callChat: any, task: string, inputText: string, opts: any): Promise<string> {
  const r = await callChat(
    [{
      role: 'system',
      content:
        'You are The Mathematician. Write a precise mathematical specification.\n' +
        'RULES:\n  - NO code, NO prose explanations.\n  - Use exact notation: formulas, iteration bounds, edge cases.\n' +
        'Format:\n' +
        'Step 1: [Formula/object with full definition]\n' +
        'Step 2: [Algorithm with exact iteration bounds]\n' +
        'Step 3: [Edge cases and constraints]\n' +
        'Step 4: [Expected output format]\n' +
        'Step 5: [Verification method]',
    }, { role: 'user', content: `Task: ${task}\n\nProblem:\n${inputText}\n\nSpec:` }],
    false, null,
    { ...opts, think: false, samplingProfile: 'reasoning' }
  );
  return (r.content || '').trim();
}

export async function engineerAgent(callChat: any, mathSpec: string, task: string, inputText: string, language: string, opts: any): Promise<string> {
  const isJS = language === 'javascript';
  const label = isJS ? 'JavaScript (Node.js)' : 'Python 3';
  const outFn = isJS ? 'console.log()' : 'print()';
  const libs = isJS
    ? 'Use BigInt for large integers. Implement combinatorics with BigInt.'
    : 'Prefer sympy/fractions for exact arithmetic. Use itertools for enumeration.';
  const r = await callChat(
    [{
      role: 'system',
      content:
        `You are The Software Engineer. Implement the mathematical spec EXACTLY — do NO math yourself.\n` +
        `RULES:\n  - NEVER hardcode computed values — always compute them.\n  - ${outFn} must be the LAST statement in the script.\n  - Output ONLY the complete runnable script — no explanation, no markdown fences.\n  - ${libs}`,
    }, { role: 'user', content: `Spec:\n${mathSpec}\n\nTask: ${task}\n\nProblem:\n${inputText}\n\nWrite the complete ${label} script:` }],
    false, null,
    { ...opts, think: false, samplingProfile: 'code' }
  );
  return stripCodeFences(r.content || '');
}

export async function fixCodeRuntime(callChat: any, task: string, code: string, language: string, error: string): Promise<string> {
  const r = await callChat(
    [{
      role: 'system',
      content: `Fix the ${language} runtime error below.\nOutput ONLY the complete corrected script — no explanation, no markdown fences.`,
    }, { role: 'user', content: `Task: ${task}\n\nCode:\n${code}\n\nError:\n${error}\n\nFixed script:` }],
    false, null,
    { think: false, samplingProfile: 'code' }
  );
  return stripCodeFences(r.content || '');
}

export async function runMCTSApproaches(callChat: any, task: string, inputText: string, opts: any = {}): Promise<{ result: string; count: number; total: number; confidence: string; sandboxValidated: boolean } | null> {
  if (!process.env.PYTHON_BIN) return null;
  const isSimpleMath = /calculate|multiply|add|subtract|sum/i.test(task) && task.length < 50;
  if (isSimpleMath) return null;
  const NUM = opts.mctsNumApproaches ?? 4;
  const THRESHOLD = opts.mctsConsensusThreshold ?? 3;
  const approaches: Array<{ name: string; domain: string; algorithm: string }> = [];
  const usedDomains: string[] = [];
  for (let i = 0; i < NUM; i++) {
    const priorNote = approaches.length
      ? `\nAlready used: ${approaches.map(a => `[${a.domain}]`).join(', ')}. Use a different domain from: ${MATH_DOMAINS.filter(d => !usedDomains.includes(d)).join(', ')}`
      : `\nAvailable domains: ${MATH_DOMAINS.join(', ')}`;
    const r = await callChat(
      [{
        role: 'system',
        content: 'Generate ONE unique algorithmic approach using a specific mathematical domain.\nOutput ONLY valid JSON: {"name":"...","domain":"...","algorithm":"..."}\nNo prose, no markdown fences.',
      }, { role: 'user', content: `Task: ${task}\nProblem: ${inputText}${priorNote}\nApproach ${i + 1}:` }],
      false, null,
      { ...opts, think: false, samplingProfile: 'json' }
    );
    try {
      const p = JSON.parse(stripCodeFences(r.content || '{}'));
      if (p.algorithm && p.domain) {
        approaches.push(p);
        usedDomains.push(p.domain);
      }
    } catch { /* ignore */ }
  }
  if (new Set(approaches.map(a => a.domain)).size < 2) return null;
  const settled = await Promise.allSettled(
    approaches.map(async ap => {
      const aTask = `${task}\nAlgorithm to use: ${ap.algorithm}`;
      const spec = await mathematicianAgent(callChat, aTask, inputText, opts);
      let code = await engineerAgent(callChat, spec, aTask, inputText, 'python', opts);
      let output: string | null = null;
      for (let a = 0; a < 2; a++) {
        try {
          output = await runPythonSandbox(code);
          break;
        } catch (e) {
          if (a < 1) code = await fixCodeRuntime(callChat, aTask, code, 'python', (e as Error).message);
          else throw e;
        }
      }
      if (!output) throw new Error(`No output from "${ap.name}"`);
      // eslint-disable-next-line no-console
      console.log(`[MCTS] "${ap.name}" [${ap.domain}] → ${output.slice(0, 60)}`);
      return { domain: ap.domain, result: output };
    })
  );
  const ok = settled.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<{ domain: string; result: string }>).value);
  if (!ok.length) return null;
  const freq = new Map<string, { count: number; result: string; domains: string[] }>();
  for (const s of ok) {
    let found = false;
    for (const [k, e] of freq) {
      if (compareResults(k, s.result)) { e.count++; e.domains.push(s.domain); found = true; break; }
    }
    if (!found) freq.set(s.result, { count: 1, result: s.result, domains: [s.domain] });
  }
  let best: { count: number; result: string; domains: string[] } | null = null;
  for (const e of freq.values()) if (!best || e.count > best.count) best = e;
  if (!best) return null;
  const distinctDomains = new Set(best.domains);
  const confidence = best.count >= THRESHOLD && distinctDomains.size >= 2 ? 'HIGH'
    : best.count >= 2 ? 'MEDIUM' : 'LOW';
  // validated = independent approaches from >=2 domains agree at HIGH
  // (>=3 votes). MEDIUM (2 votes) is a candidate, not ground truth.
  // eslint-disable-next-line no-console
  console.log(`[MCTS] Consensus: ${best.result} — ${best.count}/${ok.length} agree — confidence=${confidence}`);
  return { result: best.result, count: best.count, total: ok.length, confidence, sandboxValidated: confidence === 'HIGH' };
}

export async function reconcileResults(jsResult: string, pyResult: string | null): Promise<string> {
  if (jsResult === pyResult) return jsResult;
  if (compareResults(jsResult, pyResult)) return jsResult;
  return pyResult !== null ? pyResult : jsResult;
}

export async function generateAndRunCode(callChat: any, task: string, inputText: string, opts: any = {}): Promise<{ result: string; jsResult: string | null; pyResult: string | null; sandboxValidated: boolean; mctsConsensus?: any }> {
  const max = 2;
  if (opts.mcts !== false) {
    try {
      const m = await runMCTSApproaches(callChat, task, inputText, opts);
      if (m && m.confidence !== 'LOW') {
        // MEDIUM consensus (2 votes) still beats the single-path fallback,
        // but only HIGH is stamped validated.
        return { result: m.result, jsResult: null, pyResult: m.result, sandboxValidated: m.confidence === 'HIGH', mctsConsensus: m };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[MCTS] ${(e as Error).message} — falling back`);
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
      const isOOM = /killed|oom|timeout/i.test((e as Error).message);
      if (isOOM && a === 0) {
        const constrained = task + '\nPREVIOUS FAILED: OOM/TIMEOUT. Derive O(N²) or better algorithm.';
        jsCode = await engineerAgent(
          callChat,
          await mathematicianAgent(callChat, constrained, inputText, opts),
          constrained, inputText, 'javascript', opts
        );
      } else if (a < max - 1) {
        jsCode = await fixCodeRuntime(callChat, task, jsCode, 'javascript', (e as Error).message);
      } else throw e;
    }
  }
  let pyResult: string | null = null;
  if (process.env.PYTHON_BIN) {
    let pyCode = await engineerAgent(callChat, spec, task, inputText, 'python', opts);
    for (let a = 0; a < max; a++) {
      try {
        pyResult = await runPythonSandbox(pyCode);
        break;
      } catch (e) {
        if (a < max - 1) pyCode = await fixCodeRuntime(callChat, task, pyCode, 'python', (e as Error).message);
        else { pyResult = null; break; }
      }
    }
  }
  const result = pyResult !== null ? await reconcileResults(jsResult, pyResult) : jsResult;
  // only cross-validated results are ground truth: JS and Python must agree.
  // a single implementation that merely ran without crashing is a candidate —
  // stamping it "validated" forced wrong answers down the whole pipeline.
  const validated = pyResult !== null && compareResults(jsResult, pyResult);
  if (!validated && pyResult !== null) {
    // eslint-disable-next-line no-console
    console.warn(`[SANDBOX] JS "${jsResult}" vs PY "${pyResult}" disagree — treating as candidate, not ground truth`);
  }
  return { result, jsResult, pyResult, sandboxValidated: validated };
}
