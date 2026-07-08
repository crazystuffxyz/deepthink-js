// examples/research.js
import Deepthink from '../thinking/deepthink.js';
import runDeepResearch from '../thinking/researchAgent.js';

const apiKeys = [];
const dt = new Deepthink(
  'cogito-2.1:671b-cloud',
  apiKeys,
  {},
  Infinity,
  'qwen3-vl:235b-instruct-cloud'
);

async function main() {
  if (typeof runDeepResearch !== 'function') {
    throw new Error('researchAgent.js default export was not found.');
  }
  const callChat = dt.callChat.bind(dt);
  const prompt = `# Research-Level Problem: Analytic Number Theory & Möbius Function Let [
F(s) = sum_{n=1}^{infty} rac{mu(n)}{n^s}
] where ( mu(n) ) is the Möbius function. --- ## Part A — Analytic Identity Show that for ( Re(s) > 1 ),
[
F(s) = rac{1}{zeta(s)}
] --- ## Part B — Behavior in the Critical Strip Assume analytic continuation of ( zeta(s) ). Investigate the behavior of ( F(s) ) in the region:
[
0 < Re(s) < 1
] Prove or disprove: > There exists a sequence ( s_k o rac{1}{2} + it_k ) such that > [
|F(s_k)| o infty
] --- ## Part C — Möbius Partial Sums Define:
[
M(x) = sum_{n le x} mu(n)
] Prove that the statement:
[
M(x) = Oleft(x^{1/2+epsilon}
ight)
quad ext{for all } epsilon > 0
]
is equivalent to the Riemann Hypothesis. --- ## Part D — Advanced Exploration (Open-Ended) Define:
[
G(s) = sum_{n=1}^{infty} rac{mu(n)log n}{n^s}
] 1. Express ( G(s) ) in terms of ( zeta(s) ) and its derivatives 2. Analyze the behavior of ( G(s) ) near zeros of ( zeta(s) ) 3. Conjecture whether ( G(s) ) encodes information about zero multiplicity 4. Propose a condition involving ( G(s) ) that would imply simplicity of zeros`;
  const result = await runDeepResearch(callChat, prompt, {
    maxQueries: 3,
    maxConcurrency: 20,
    credibilityThreshold: 35,
    maxSummaries: 5,
    useOllamaSearch: true,
    academicFilter: false,
  });
  console.log('\n================ DEEP RESEARCH REPORT ================\n');
  console.log(result.report || 'no report returned');
  console.log('\n================ METADATA ================\n');
  console.log(
    JSON.stringify(
      {
        success: result.success,
        claimCount: result.claimCount,
        referenceCount: (result.references || []).length,
        stepSummary: result.stepSummary,
      },
      null,
      2
    )
  );
  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('fatal error:', err);
  process.exit(1);
});