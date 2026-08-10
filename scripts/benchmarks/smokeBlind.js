// smokeBlind.js — verify checkStyle:'blind' live against ollama.
// minimal probe: 1 problem, depth 1, 2 blind checks. prints phases + verdict.
import Deepthink from '../../dist/index.js';

const dt = new Deepthink('gemma4:31b-cloud', [], {}, 2, 'deepseek-v4-flash:0731-cloud');

try {
  const input = 'A rectangle has perimeter 30 and area 54. What is its longer side? Return the answer as [number].';
  const r = await dt.generate(input, { depth: 1, checks: 2, checkStyle: 'blind' });
  console.log('RESULT:', typeof r === 'string' ? r.slice(0, 300) : JSON.stringify(r).slice(0, 300));
  const t = dt._lastTrace;
  console.log('TRACE events:', t.size);
  console.log('PHASES:', JSON.stringify(t.events.filter((e) => e.phase).map((e) => e.phase)));
  const checks = t.events.filter((e) => e.phase === 'checks');
  console.log('CHECK CALLS:', checks.length, '| models:', JSON.stringify(checks.map((e) => e.model)));
  console.log('CHECK PROMPTS:', checks.map((e) => (e.prompt || '').slice(-220)));
} catch (err) {
  console.error('ERR:', err.message);
} finally {
  dt.destroy();
}
