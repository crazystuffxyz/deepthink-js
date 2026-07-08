// test_providers.js — build a few clients, test callChat is callable. Pure offline test.
'use strict';

import { buildProviderClient, buildOllamaClient, buildOpenAICompatClient } from '../providers/index.js';

function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }

// ollama client: just check it's an object with a chat function
const ollama = buildOllamaClient({ host: 'http://localhost:11434' }, null);
ok(typeof ollama.chat === 'function', 'ollama client has chat');

// openai-compat: same shape
const oci = buildOpenAICompatClient({ baseUrl: 'https://example.com/v1' }, 'sk-test');
ok(typeof oci.chat === 'function', 'openai-compat has chat');

// buildProviderClient routing
const c1 = buildProviderClient({ provider: 'ollama' });
ok(typeof c1.chat === 'function', 'route ollama');
const c2 = buildProviderClient({ provider: 'openai-compat' });
ok(typeof c2.chat === 'function', 'route openai-compat');
const c3 = buildProviderClient({ provider: 'lmstudio' });
ok(typeof c3.chat === 'function', 'route lmstudio');
const c4 = buildProviderClient({ provider: 'claude' });
ok(typeof c4.chat === 'function', 'route claude');
const c5 = buildProviderClient({ provider: 'gemini' });
ok(typeof c5.chat === 'function', 'route gemini');
const c6 = buildProviderClient({ provider: 'perplexity' });
ok(typeof c6.chat === 'function', 'route perplexity');
const c7 = buildProviderClient({ provider: 'grok' });
ok(typeof c7.chat === 'function', 'route grok');
const c8 = buildProviderClient({ provider: 'custom' });
ok(typeof c8.chat === 'function', 'route custom');

console.log('providers (pure): ALL PASS');
