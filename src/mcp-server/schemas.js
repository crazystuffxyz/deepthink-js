// src/mcp-server/schemas.js
// zod input schemas for every tool. kept separate from the tool registry so
// index.js can register them with the MCP SDK cleanly.
import { z } from 'zod';

const str = (d) => z.string().describe(d);
const num = (d) => z.number().describe(d);
const bool = (d) => z.boolean().describe(d);
const optStr = (d) => z.string().optional().describe(d);
const optNum = (d) => z.number().optional().describe(d);
const optBool = (d) => z.boolean().optional().describe(d);
const optObj = (d) => z.record(z.string(), z.any()).optional().describe(d);
const optArr = (d) => z.array(z.string()).optional().describe(d);
const anyVal = (d) => z.any().describe(d);

// deepthink-native LLM + research + humanize
const reason = {
  prompt: str('The problem or question to reason about'),
  type: z.enum(['string', 'integer', 'double', 'boolean', 'json']).optional().describe('Expected output type (default string)'),
  depth: z.number().min(0).max(3).optional().describe('Reasoning depth 0-3 (default 1)'),
  enableCode: optBool('Allow sandboxed code execution (default true)'),
  model: optStr('Model to use (defaults to the configured model)'),
};
const generate = {
  prompt: str('The prompt to generate a response for'),
  type: optStr('Expected output type (string|integer|double|boolean|json)'),
  depth: optNum('DeepThink reasoning depth 0-3'),
  checks: optNum('Number of verification checks (0-3)'),
  mcts: optBool('Run MCTS tree search over the reasoning path'),
  model: optStr('Model to use'),
};
const generateJSON = {
  prompt: str('The prompt; the model must return valid JSON'),
  depth: optNum('DeepThink reasoning depth'),
  checks: optNum('Verification checks'),
  mcts: optBool('Use MCTS'),
  model: optStr('Model to use'),
};
const deepResearch = {
  topic: str('The research topic or question'),
  model: optStr('Model to use'),
  depth: optNum('Reasoning depth'),
  checks: optNum('Verification checks'),
  maxIterations: optNum('Max research iterations'),
  maxConcurrency: optNum('Max concurrent fetches'),
  files: optArr('Local files to inject as high-credibility sources'),
  academicFilter: optBool('Prefer academic sources'),
  mode: optStr('research mode (e.g. stock)'),
  maxSteps: optNum('Max sub-steps'),
};
const ollamaChat = {
  messages: z.array(z.any()).describe('Chat messages [{role, content}]'),
  model: optStr('Model to use'),
  system: optStr('Optional system prompt'),
  stream: optBool('Stream tokens as they arrive'),
};
const setApiKey = {
  apiKey: str('Ollama API key to use'),
};
const checkScore = {
  text: str('Text to score for human-likeness'),
  mode: optStr('Scoring mode'),
};
const humanizeText = {
  text: str('Text to humanize'),
  intensity: optNum('How aggressively to remove AI tells (0-1)'),
  model: optStr('Model to use'),
};

// auto-agents
const mctsSearch = {
  goal: str('The goal the tool sequence should achieve'),
  state: optObj('Current state (feeds loop detection + scoring)'),
  candidates: z.array(z.object({ tool: str('tool name'), params: optObj('tool params'), narration: optStr('narration') })).describe('Candidate tool calls to rank'),
  iterations: optNum('MCTS iterations (default 12)'),
  exploration: optNum('UCB1 exploration constant'),
  maxBranching: optNum('Max child nodes per expansion'),
};
const beamSearch = {
  goal: str('The goal the tool sequence should achieve'),
  state: optObj('Current state'),
  candidates: z.array(z.any()).describe('Candidate tool calls'),
  k: optNum('How many top candidates to return'),
  maxPairs: optNum('Max pairwise comparisons'),
};
const agentRun = {
  program: z.object({
    nodes: z.record(z.string(), z.any()).describe('Named graph nodes'),
    entry: optStr('Starting node name'),
    state: optObj('Initial state'),
    maxSteps: optNum('Step cap'),
    maxLoopIterations: optNum('Loop cap'),
  }).describe('The agent graph program'),
};
const commanderProcess = {
  request: str('The user request to plan and execute'),
  model: optStr('Main model'),
  modelConfig: optObj('Per-role model overrides'),
  history: optArr('Conversation history'),
};
const commanderPlan = {
  request: str('The user request to decompose into steps'),
  model: optStr('Planner model'),
  history: optArr('Conversation history'),
};

// runner / filesystem / web / desktop
const shell = {
  command: str('The shell command to run'),
  cwd: optStr('Working directory'),
  timeout: optNum('Timeout in ms'),
};
const powershell = {
  command: str('The command to run'),
  cwd: optStr('Working directory'),
};
const jsExecute = {
  code: str('JavaScript to run sandboxed (state in scope)'),
  state: optObj('State made available to the script'),
};
const readFile = {
  path: str('Absolute path to the file'),
  encoding: optStr('Text encoding (default utf8)'),
};
const writeFile = {
  path: str('Absolute path to the file'),
  content: str('Content to write'),
  append: optBool('Append instead of overwrite'),
};
const listDir = {
  path: optStr('Directory to list (default cwd)'),
  recursive: optBool('Recurse into subdirectories'),
};
const createDir = {
  path: str('Directory path to create (recursive)'),
};
const deleteFile = {
  path: str('Path of the file to delete (tracked for rollback)'),
};
const copyFile = {
  src: str('Source path'),
  dest: str('Destination path'),
};
const rollback = {
  _unused: optStr('No arguments'),
};
const webSearch = {
  query: str('Search query'),
  maxResults: optNum('Max results'),
};
const webFetch = {
  url: str('URL to fetch'),
  maxLength: optNum('Max characters of extracted text'),
};
const httpRequest = {
  url: str('URL to request'),
  method: optStr('HTTP method (default GET)'),
  headers: optObj('Request headers'),
  body: optStr('Request body'),
};
const openUrl = {
  url: str('URL to open in the default browser'),
};
const systemInfo = {
  _unused: optStr('No arguments'),
};
const listProcesses = {
  _unused: optStr('No arguments'),
};
const killProcess = {
  pid: optNum('Process id to kill'),
  name: optStr('Process name to kill'),
};
const envVar = {
  name: str('Environment variable name'),
  value: optStr('Value to set (omit to read)'),
};
const wait = {
  ms: optNum('Milliseconds to sleep (max 60000)'),
};
const screenshot = {
  save: optBool('Save the screenshot to disk'),
};
const mouseMove = {
  x: num('X coordinate'),
  y: num('Y coordinate'),
};
const mouseClick = {
  x: num('X coordinate'),
  y: num('Y coordinate'),
  button: optStr('Button (left/right/middle)'),
  double: optBool('Double click'),
};
const typeText = {
  text: str('Text to type'),
  delay: optNum('Delay between keystrokes in ms'),
};
const keyboard = {
  key: str('Key to press (e.g. Enter, Tab, F5)'),
  modifiers: optArr('Modifier keys (e.g. ctrl, alt, shift)'),
};
const cancel = {
  _unused: optStr('No arguments'),
};
const getClipboard = {
  _unused: optStr('No arguments'),
};
const setClipboard = {
  text: str('Text to write to the clipboard'),
};
const aiAnalyze = {
  data: str('Data blob to analyze'),
  question: str('Question to answer about the data'),
  model: optStr('Model to use'),
};
const analyzeImage = {
  base64: str('Base64-encoded image data'),
  question: optStr('Specific question about the image'),
  model: optStr('Vision model to use'),
};
const git = {
  command: str('Git command to run'),
  cwd: optStr('Working directory'),
};
const nodeRun = {
  code: optStr('Node.js code to run'),
  file: optStr('Script file to run'),
};
const pythonRun = {
  code: optStr('Python code to run'),
  file: optStr('Script file to run'),
};

// code intelligence
const searchCode = {
  root: optStr('Codebase root (default cwd)'),
  query: str('Text or regex to search for'),
  regex: optBool('Treat query as regex'),
  caseSensitive: optBool('Case sensitive match'),
  filePattern: optStr('Restrict to matching file paths'),
  limit: optNum('Max matches'),
};
const findFiles = {
  root: optStr('Codebase root (default cwd)'),
  namePattern: str('Glob-ish name pattern (supports * and **)'),
  limit: optNum('Max results'),
};
const projectOverview = {
  root: optStr('Codebase root (default cwd)'),
  limit: optNum('Top entries per category'),
};
const importMap = {
  root: optStr('Codebase root (default cwd)'),
};
const listFunctions = {
  file: str('Path to a JS/TS file'),
};
const auditDeps = {
  root: optStr('Codebase root (default cwd)'),
};

// documents + vision
const parseDocument = {
  path: str('Path to a pdf/docx/xlsx/csv/html/md/json file'),
};
const designSvg = {
  source: str('Image source (path, url, or base64)'),
  goal: optStr('Design goal'),
  iterations: optNum('Draft->critique->revise iterations'),
  model: optStr('Vision model'),
  threshold: optNum('Score at which to stop (0-100)'),
  width: optNum('Target width'),
  height: optNum('Target height'),
};

// skills
const listSkills = {
  _unused: optStr('No arguments'),
};
const runSkill = {
  name: str('Skill name'),
  _rest: z.record(z.string(), z.any()).optional().describe('Skill-specific parameters'),
};

// memory
const memorySet = {
  namespace: str('Namespace (default "default")'),
  key: str('Key'),
  value: anyVal('Value to store (must be JSON-serializable)'),
  ttlMs: optNum('Optional time-to-live in ms'),
};
const memoryGet = {
  namespace: optStr('Namespace (default "default")'),
  key: str('Key'),
};
const memorySearch = {
  namespace: optStr('Namespace (default "default")'),
  query: str('Substring to search for'),
  limit: optNum('Max results'),
};
const memoryList = {
  namespace: optStr('Namespace (default "default")'),
};
const memoryDelete = {
  namespace: optStr('Namespace (default "default")'),
  key: str('Key'),
};
const memoryGc = {
  _unused: optStr('No arguments'),
};

// misc
const getCurrentTime = { _unused: optStr('No arguments') };
const rollDice = { sides: optNum('Number of sides (default 6)') };
const coinFlip = { _unused: optStr('No arguments') };
const echoMessage = { message: str('Message to echo back') };
const randomNumber = { min: optNum('Inclusive lower bound'), max: optNum('Inclusive upper bound') };
const getEventLog = { limit: optNum('How many recent events to return') };

export const SCHEMAS = {
  deepthink_reason: reason,
  deepthink_generate: generate,
  deepthink_json: generateJSON,
  deep_research: deepResearch,
  ollama_chat: ollamaChat,
  deepthink_set_api_key: setApiKey,
  deepthink_check_score: checkScore,
  deepthink_humanize_text: humanizeText,
  list_models: {},
  ollama_health: {},
  deepthink_mcts_search: mctsSearch,
  deepthink_beam_search: beamSearch,
  deepthink_agent: agentRun,
  deepthink_process: commanderProcess,
  deepthink_plan: commanderPlan,
  deepthink_shell: shell,
  deepthink_powershell: powershell,
  deepthink_js_execute: jsExecute,
  deepthink_read_file: readFile,
  deepthink_write_file: writeFile,
  deepthink_list_dir: listDir,
  deepthink_create_dir: createDir,
  deepthink_delete_file: deleteFile,
  deepthink_copy_file: copyFile,
  deepthink_rollback: rollback,
  deepthink_web_search: webSearch,
  deepthink_web_fetch: webFetch,
  deepthink_http_request: httpRequest,
  deepthink_open_url: openUrl,
  deepthink_system_info: systemInfo,
  deepthink_list_processes: listProcesses,
  deepthink_kill_process: killProcess,
  deepthink_env_var: envVar,
  deepthink_wait: wait,
  deepthink_screenshot: screenshot,
  deepthink_mouse_move: mouseMove,
  deepthink_mouse_click: mouseClick,
  deepthink_type_text: typeText,
  deepthink_keyboard: keyboard,
  deepthink_cancel: cancel,
  deepthink_get_clipboard: getClipboard,
  deepthink_set_clipboard: setClipboard,
  deepthink_ai_analyze: aiAnalyze,
  deepthink_analyze_image: analyzeImage,
  deepthink_git: git,
  deepthink_node_run: nodeRun,
  deepthink_python_run: pythonRun,
  deepthink_search_code: searchCode,
  deepthink_find_files: findFiles,
  deepthink_project_overview: projectOverview,
  deepthink_import_map: importMap,
  deepthink_list_functions: listFunctions,
  deepthink_audit_deps: auditDeps,
  deepthink_parse_document: parseDocument,
  deepthink_design_svg: designSvg,
  deepthink_list_skills: listSkills,
  deepthink_run_skill: runSkill,
  deepthink_memory_set: memorySet,
  deepthink_memory_get: memoryGet,
  deepthink_memory_search: memorySearch,
  deepthink_memory_list: memoryList,
  deepthink_memory_delete: memoryDelete,
  deepthink_memory_gc: memoryGc,
  get_current_time: getCurrentTime,
  roll_dice: rollDice,
  coin_flip: coinFlip,
  echo_message: echoMessage,
  random_number: randomNumber,
  get_event_log: getEventLog,
};

// strip the marker keys before they hit zod so no spurious "_unused" param
// shows up in the tool's declared schema
export function toZod(spec) {
  const clean = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === '_unused') continue;
    clean[k] = v;
  }
  return z.object(clean);
}
