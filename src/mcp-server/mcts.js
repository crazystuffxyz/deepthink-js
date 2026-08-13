// src/mcp-server/mcts.js
// MCTS for tool-call decision making. UCT-searches the action tree from
// the current state + candidate next actions, picks the highest simulated reward.
//
// "real" MCTS, not the yes/no approve gate the Commander used before:
//   1. select a leaf via UCB1
//   2. expand — LLM enumerates the most plausible continuations
//   3. simulate — roll out each candidate w/ cheap heuristics (resource cost,
//      risk, similarity to past successes) + an LLM self-rate when deeper scoring is needed
//   4. backpropagate — update visits/value up the path
//
// also has a `beamSearch` mode: run the top-k candidates once, rank by LLM
// score. much cheaper, good for short lookahead.
import crypto from 'node:crypto';

// required-arg schemas for the tools the risk gate actually sees. kept
// local so mcp-server/ never depends on commander/ (which imports us).
const TOOL_SCHEMAS = {
  shell: { required: { command: 'string' } },
  powershell: { required: { command: 'string' } },
  js_execute: { required: { code: 'string' } },
  read_file: { required: { path: 'string' } },
  write_file: { required: { path: 'string', content: 'string' } },
  list_dir: { required: {} },
  create_dir: { required: { path: 'string' } },
  delete_file: { required: { path: 'string' } },
  copy_file: { required: { src: 'string', dest: 'string' } },
  web_search: { required: { query: 'string' } },
  web_fetch: { required: { url: 'string' } },
  http_request: { required: { url: 'string' } },
  open_url: { required: { url: 'string' } },
  kill_process: { required: {} },
  env_var: { required: { name: 'string' } },
  mouse_move: { required: { x: 'number', y: 'number' } },
  mouse_click: { required: { x: 'number', y: 'number' } },
  type_text: { required: { text: 'string' } },
  set_clipboard: { required: { text: 'string' } },
  ai_analyze: { required: { data: 'string', question: 'string' } },
  analyze_image: { required: { base64: 'string' } },
  git: { required: { command: 'string' } },
};

const DEFAULT_CONFIG = {
  iterations: 12,
  exploration: 1.414, // sqrt(2) — UCB1 constant
  maxBranching: 4,
  discount: 0.95,
  cheap: false, // skip the LLM self-rate pass
};

class MCTSNode {
  constructor({ action, parent = null, prior = 0 }) {
    this.id = crypto.randomBytes(4).toString('hex');
    this.action = action; // { tool, params, narration }
    this.parent = parent;
    this.children = [];
    this.visits = 0;
    this.value = 0;
    this.prior = prior;
    this.depth = parent ? parent.depth + 1 : 0;
    this.expanded = false;
  }

  ucb(c) {
    if (this.visits === 0) return Infinity;
    return this.value / this.visits + c * Math.sqrt(Math.log(this.parent.visits) / this.visits);
  }

  bestChild(c) {
    return this.children.reduce((a, b) => (a.ucb(c) >= b.ucb(c) ? a : b));
  }
}

class MCTS {
  constructor(engine, config = {}) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  // Public: run MCTS, return best action + search tree summary.
  async search({ state, goal, candidates, onProgress } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { best: null, tree: null, reason: 'no_candidates' };
    }
    const root = new MCTSNode({ action: null });

    for (const c of candidates) {
      const prior = await this._scoreCandidate(c, state, goal, /*useLLM*/ false);
      root.children.push(new MCTSNode({ action: c, prior, parent: root }));
    }

    for (let i = 0; i < this.cfg.iterations; i++) {
      if (onProgress) onProgress({ iteration: i + 1, total: this.cfg.iterations });
      const path = [];
      let node = root;

      // SELECT — descend via UCB1 until an unexpanded node
      while (node.expanded && node.children.length > 0 && node.depth < 6) {
        node = node.bestChild(this.cfg.exploration);
        path.push(node);
      }

      // EXPAND — generate continuations with the LLM (or use prior ranking)
      if (!node.expanded && node.depth < 4) {
        await this._expand(node, state, goal);
        node.expanded = true;
        if (node.children.length > 0) {
          node = node.children[0];
          path.push(node);
        }
      }

      // SIMULATE — score the leaf
      const reward = await this._scoreCandidate(node.action, state, goal, !this.cfg.cheap);
      node.value = reward;
      node.visits = 1;

      // BACKPROPAGATE
      let child = node;
      let cur = child.parent;
      while (cur) {
        cur.visits++;
        const childIdx = Math.max(0, cur.children.indexOf(child));
        const stepReward = reward * Math.pow(this.cfg.discount, childIdx + 1);
        cur.value += stepReward;
        child = cur;
        cur = cur.parent;
      }
    }

    const best = root.children.reduce((a, b) => (a.visits >= b.visits ? a : b));
    return {
      best: best.action,
      tree: this._summarizeTree(root),
      reason: 'mcts',
      confidence: best.visits / this.cfg.iterations,
    };
  }

  async _expand(node, state, goal) {
    if (!node.action) return;
    const prompt = this._continuationPrompt(node.action, state, goal);
    try {
      const result = await this.engine.generateJSON({
        model: state?.model || this.engine.defaultModel,
        prompt,
        depth: 0,
        checks: 0,
        mcts: false,
      });
      const continuations = (result.continuations || []).slice(0, this.cfg.maxBranching);
      for (const c of continuations) {
        const prior = await this._scoreCandidate(c, state, goal, false);
        node.children.push(new MCTSNode({ action: c, prior, parent: node }));
      }
    } catch {
      // expansion failed — leave children empty
    }
  }

  _continuationPrompt(action, state, goal) {
    return `You are simulating the next steps in a tool-use trajectory. Given:
GOAL: ${goal || 'unspecified'}
CURRENT STATE: ${JSON.stringify(state || {}).slice(0, 800)}
LAST ACTION: ${JSON.stringify(action).slice(0, 400)}

Predict the top 2-4 plausible NEXT actions (tool calls) that a competent agent would take.
Respond ONLY with valid JSON: {"continuations":[{"tool":"...","params":{...},"narration":"..."}, ...]}`;
  }

  // score a candidate. deterministic signals first (arg schema, risk, loop),
  // LLM only when asked — the LLM pass is the expensive part, so it's
  // reserved for leaf nodes.
  async _scoreCandidate(action, state, goal, useLLM) {
    if (!action) return 0;
    let score = 0.5;

    // deterministic floor — zero cost, always on
    if (this._validateArgs(action)) score += 0.15;
    else score -= 0.25; // malformed args are a near-certain failure
    if (this._isReadOnly(action.tool)) score += 0.15;
    if (this._isReversible(action.tool)) score += 0.1;
    if (this._isHighRisk(action.tool)) score -= 0.2;
    if (this._looksLikeLoop(action, state)) score -= 0.3;

    // model self-rate pass (more expensive but more accurate)
    if (useLLM) {
      try {
        const prompt = `Rate this proposed tool action on a 0-100 scale for whether it will help accomplish the goal.
GOAL: ${goal || 'unspecified'}
ACTION: ${JSON.stringify(action).slice(0, 600)}
Respond ONLY with JSON: {"score": <0-100>, "reason": "..."}`;
        const r = await this.engine.generateJSON({
          model: state?.model || this.engine.defaultModel,
          prompt,
          depth: 0,
          checks: 0,
          mcts: false,
        });
        const llm = Number(r.score) / 100;
        if (Number.isFinite(llm)) score = score * 0.4 + llm * 0.6;
      } catch {
        // LLM scoring is best-effort
      }
    }
    return Math.max(0, Math.min(1, score));
  }

  // check params against the tool's declared schema. unknown tools pass
  // (can't validate what we don't know); known tools need all required
  // params w/ the right types.
  _validateArgs(action) {
    const def = TOOL_SCHEMAS[_base(action.tool)];
    if (!def) return true;
    const params = action.params || {};
    for (const [k, type] of Object.entries(def.required || {})) {
      const v = params[k];
      if (v === undefined || v === null || v === '') return false;
      if (type === 'number' && typeof v !== 'number') return false;
      if (type === 'string' && typeof v !== 'string') return false;
    }
    return true;
  }

  _isReadOnly(tool) {
    return [
      'read_file',
      'list_dir',
      'web_search',
      'web_fetch',
      'ollama_health',
      'list_models',
      'get_current_time',
      'check_score',
      'system_info',
      'list_processes',
      'get_event_log',
    ].includes(_base(tool));
  }
  _isReversible(tool) {
    return ['write_file', 'copy_file', 'create_dir'].includes(_base(tool));
  }
  _isHighRisk(tool) {
    return ['delete_file', 'kill_process', 'shell', 'powershell', 'env_var', 'set_clipboard'].includes(_base(tool));
  }
  _looksLikeLoop(action, state) {
    if (!state || !state.__history) return false;
    const recent = state.__history.slice(-4);
    return recent.some(
      (h) => h && _base(h.tool) === _base(action.tool) && JSON.stringify(h.params) === JSON.stringify(action.params),
    );
  }

  _summarizeTree(root) {
    const out = [];
    const walk = (n, depth = 0) => {
      if (depth > 3) return;
      out.push({
        depth,
        id: n.id,
        action: n.action ? `${n.action.tool}` : 'root',
        visits: n.visits,
        value: Number(n.value.toFixed(3)),
        prior: Number(n.prior.toFixed(3)),
      });
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(root);
    return out;
  }
}

// Cheap beam search: top-k candidates via a pairwise tournament.
// Research finding: list-wise ranking of 3+ candidates is unreliable —
// pairwise comparisons judged in BOTH orders, requiring agreement, are far
// more stable. on disagreement the pair falls back to heuristics.
// `maxPairs` caps judged pairs (each pair = 2 LLM calls) — pairs sorted by
// heuristic score so a cap still ranks the important ones.
async function beamSearch({ engine, candidates, state, goal, k = 3, useLLM = true, maxPairs = Infinity }) {
  if (!candidates || candidates.length === 0) return { best: null };
  const scored = candidates.map((c) => ({
    action: c,
    score: _heuristicScore(c),
  }));

  if (useLLM && candidates.length > 1) {
    // round-robin pairwise tournament: each pair judged A/B and B/A.
    // pairs sorted by combined heuristic score — strongest judged first,
    // so a cap still ranks the important ones.
    const pairs = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        pairs.push({ i, j, w: scored[i].score + scored[j].score });
      }
    }
    pairs.sort((a, b) => b.w - a.w);
    const wins = new Array(candidates.length).fill(0);
    for (const { i, j } of pairs.slice(0, maxPairs)) {
      const verdict = await _pairwiseJudge(engine, candidates[i], candidates[j], state, goal);
      if (verdict === 'A') wins[i]++;
      else if (verdict === 'B') wins[j]++;
      // 'tie' or error -> no win, heuristic score stands
    }
    const maxWins = Math.max(...wins);
    if (maxWins > 0) {
      for (let i = 0; i < scored.length; i++) {
        scored[i].score = 0.5 + (wins[i] / Math.max(1, maxWins)) * 0.5;
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    best: scored.slice(0, k).map((s) => s.action),
    ranking: scored,
  };
}

// judge one pair in both orders, require agreement. returns 'A' | 'B' | 'tie'.
async function _pairwiseJudge(engine, a, b, state, goal) {
  const judge = async (first, second) => {
    const prompt = `Which tool action is more likely to accomplish the goal? Answer with ONLY the letter.
GOAL: ${goal || 'unspecified'}
A: ${JSON.stringify(first).slice(0, 300)}
B: ${JSON.stringify(second).slice(0, 300)}
Respond ONLY with "A" or "B".`;
    try {
      const raw = await engine.generate(prompt, {
        model: state?.model || engine.defaultModel,
        type: 'string',
      });
      const t = String(raw || '')
        .trim()
        .toUpperCase();
      if (t.startsWith('A')) return 'A';
      if (t.startsWith('B')) return 'B';
      return 'tie';
    } catch {
      return 'tie';
    }
  };
  const ab = await judge(a, b);
  const ba = await judge(b, a);
  if (ab === 'A' && ba === 'B') return 'A';
  if (ab === 'B' && ba === 'A') return 'B';
  return 'tie';
}

// strip the deepthink_ prefix so native + MCP tool names hit the same rules
function _base(tool) {
  return String(tool || '').replace(/^deepthink_/, '');
}

function _heuristicScore(action) {
  if (!action) return 0;
  let s = 0.5;
  const r = [
    'read_file',
    'list_dir',
    'web_search',
    'web_fetch',
    'ollama_health',
    'list_models',
    'get_current_time',
    'check_score',
    'system_info',
    'list_processes',
    'get_event_log',
  ];
  const risk = ['delete_file', 'kill_process', 'shell', 'powershell', 'env_var', 'set_clipboard'];
  if (r.includes(_base(action.tool))) s += 0.2;
  if (risk.includes(_base(action.tool))) s -= 0.2;
  return s;
}

export { MCTS, beamSearch, _heuristicScore };
