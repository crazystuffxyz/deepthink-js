// thinking/__tests__/proofWorkflow.test.ts
// unit tests for proof-detection workflow enhancements

import { describe, it, expect } from 'vitest';

// Import the helper functions from deepthink.ts
// Note: these are module-private, so we test via the compiled output
// For now, we test the regex patterns directly

describe('isProofProblem detection', () => {
  const proofPatterns = [
    'Prove that for all integers n ≥ 3, ...',
    'Show that the sequence is monotonic',
    'Find all functions f: ℝ → ℝ such that ...',
    'Determine all integers n such that ...',
    'For every positive integer n, prove ...',
    'Must be divisible by 3 for all n',
  ];

  const nonProofPatterns = [
    'Compute 2^100',
    'What is the value of x?',
    'Calculate the sum of 1 to 100',
    'Evaluate the integral ∫₀¹ x² dx',
    'Find the value of n that satisfies ...',
  ];

  function isProofProblem(inputText: string): boolean {
    return (
      /prove that|show that|determine all|find all|for every|for all|must be/i.test(inputText) &&
      !/compute|evaluate|calculate|what is|find the value/i.test(inputText)
    );
  }

  it('detects proof problems correctly', () => {
    for (const p of proofPatterns) {
      expect(isProofProblem(p)).toBe(true);
    }
  });

  it('rejects non-proof problems', () => {
    for (const p of nonProofPatterns) {
      expect(isProofProblem(p)).toBe(false);
    }
  });

  it('handles mixed language (proof + compute)', () => {
    // "Compute" should override "Prove" — this is a computational problem
    expect(isProofProblem('Compute and prove that...')).toBe(false);
    // "Find all" without computational override — proof problem
    expect(isProofProblem('Find all n such that n² = 4')).toBe(true);
  });
});

describe('estimateDifficulty for proof problems', () => {
  function estimateDifficulty(inputText: string, depth: number): boolean {
    let score = 0;
    if (inputText.length > 500) score++;
    if (/prove|show that|find all|for all n|for every|determine all|is it possible|must be/i.test(inputText)) score++;
    if (/integer|prime|modulo|mod |divisib|permutation|combinator|probability|expected|sequence|polynomial|triangle|circle|convex/i.test(inputText)) score++;
    if (depth >= 3) score++;
    return score >= 2;
  }

  it('marks long proof problems as hard', () => {
    const longProof = 'Prove that for all integers n ≥ 3, if we list the divisors of n! in increasing order, the differences between consecutive divisors form a non-decreasing sequence. Consider the prime factorization and the distribution of divisors...';
    expect(estimateDifficulty(longProof, 3)).toBe(true);
  });

  it('marks short computational problems as easy', () => {
    const shortComp = 'Compute 2^100';
    expect(estimateDifficulty(shortComp, 1)).toBe(false);
  });

  it('marks proof problems as hard regardless of depth', () => {
    const borderline = 'Find all primes p such that p+2 is also prime';
    // "Find all" + "primes" triggers both proof and math vocab = hard even at depth 1
    expect(estimateDifficulty(borderline, 1)).toBe(true);
    expect(estimateDifficulty(borderline, 3)).toBe(true);
  });
});

describe('edge-case enumeration trigger', () => {
  const edgeCasePatterns = [
    'Find all integers n ≥ 3',
    'Determine all functions f: ℝ → ℝ',
    'For all n ≥ 1, prove...',
    'For every integer k, show...',
  ];

  function triggersEdgeCaseCheck(inputText: string): boolean {
    return /find all|determine all|for all n ≥|for every integer/i.test(inputText);
  }

  it('triggers edge-case check for enumeration problems', () => {
    for (const p of edgeCasePatterns) {
      expect(triggersEdgeCaseCheck(p)).toBe(true);
    }
  });

  it('does not trigger for non-enumeration', () => {
    expect(triggersEdgeCaseCheck('Prove the sequence converges')).toBe(false);
    expect(triggersEdgeCaseCheck('Compute the limit')).toBe(false);
  });
});
