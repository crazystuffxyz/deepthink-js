// thinking/benchmarkSet.js — 10 fixed problems used to score prompt candidates.
// Each item has a gold reference (or a rubric for the no-right-answer ones).
'use strict';

export const BENCH = [
  {
    id: 'b01-train-meet',
    kind: 'math',
    prompt: 'Train A leaves station X at 14:00 traveling toward Y at 60 km/h. Train B leaves Y at 15:00 toward X at 80 km/h. The two stations are 300 km apart. At what time do the trains meet, and how far from X?',
    reference: { time: '16:12', distanceFromX: 132 },
    numericTolerance: 0.05,
    weight: 1.0
  },
  {
    id: 'b02-cards-21',
    kind: 'probability',
    prompt: 'You draw 3 cards without replacement from a standard 52-card deck (ranks A=1, 2-10, J=11, Q=12, K=13; suits ignored). What is the probability that the sum of the three ranks is exactly 21? Express as a decimal to 4 places.',
    reference: 0.0255,
    numericTolerance: 0.02,
    weight: 1.0
  },
  {
    id: 'b03-zorp-glop',
    kind: 'logic',
    prompt: '"All Zorps are Fims. Some Fims are Glops." Does it follow that some Zorps are Glops? Answer YES, NO, or INDETERMINATE, and give a one-sentence reason plus a one-sentence counterexample if INDETERMINATE.',
    reference: { answer: 'INDETERMINATE', mustMention: 'counterexample' },
    weight: 1.0
  },
  {
    id: 'b04-palindrome',
    kind: 'code',
    prompt: 'Write a Python function is_palindrome(s) that returns True if s reads the same forwards and backwards ignoring case and non-alphanumeric characters, False otherwise. Do not use any reverse/slicing trick — only a loop. Output ONLY the function, no commentary.',
    reference: { lang: 'python', functionName: 'is_palindrome', testCases: [
        { input: '"A man, a plan, a canal: Panama"', expected: true },
        { input: '"race a car"', expected: false },
        { input: '"Was it a car or a cat I saw?"', expected: true },
        { input: '"empty"', expected: false }
    ]},
    weight: 1.5
  },
  {
    id: 'b05-gravity',
    kind: 'science',
    prompt: 'A planet has twice Earth\'s radius and 8 times Earth\'s mass. What is the surface gravity compared to Earth (in g)?',
    reference: 2.0,
    numericTolerance: 0.01,
    weight: 1.0
  },
  {
    id: 'b06-liar-paradox',
    kind: 'paradox',
    prompt: 'Resolve the liar-paradox statement "This sentence is false". In one paragraph, commit to a position. Acknowledge the difficulty honestly. Do not retreat to "it is meaningless" unless you can defend that.',
    reference: null,
    rubric: {
      commitsToPosition: 0.4,
      acknowledgesDifficulty: 0.3,
      nonTrivialArgument: 0.3
    },
    weight: 1.0
  },
  {
    id: 'b07-einstein',
    kind: 'deduction',
    prompt: 'Five houses in a row, each painted a different color (red, blue, green, yellow, white), occupied by a person of a different nationality (Brit, Swede, Dane, Norwegian, German), who drinks a different beverage (tea, coffee, milk, beer, water), keeps a different pet (dogs, birds, cats, horses, fish), and smokes a different brand (PallMall, Dunhill, Blend, BlueMaster, Prince). Clues: (1) The Brit lives in the red house. (2) The Swede keeps dogs. (3) The Dane drinks tea. (4) The green house is immediately to the left of the white house. (5) The owner of the green house drinks coffee. (6) The PallMall smoker keeps birds. (7) The owner of the yellow house smokes Dunhill. (8) The man in the center house drinks milk. (9) The Norwegian lives in the first house. (10) The Blend smoker lives next to the cat owner. (11) The Dunhill smoker lives next to the horse owner. (12) The BlueMaster smoker drinks beer. (13) The German smokes Prince. (14) The Norwegian lives next to the blue house. (15) The Blend smoker lives next to the water drinker. Who owns the fish?',
    reference: 'German',
    weight: 2.0
  },
  {
    id: 'b08-launch',
    kind: 'planning',
    prompt: 'You have one engineer, no budget, and 3 days to launch a small open-source CLI tool. Write a launch plan: at most 6 steps, each with a one-line "what gets done" and a one-line "what could kill it".',
    reference: null,
    rubric: {
      concreteSteps: 0.4,
      riskMentioned: 0.3,
      sequencing: 0.3
    },
    weight: 1.0
  },
  {
    id: 'b09-hypotheses',
    kind: 'hypothesis',
    prompt: 'Coffee shops seem to cluster near universities. Generate 3 falsifiable hypotheses that could explain this. For each, name a single measurement that would refute it.',
    reference: null,
    rubric: {
      distinctHypotheses: 0.3,
      falsifiability: 0.4,
      measurementSpecific: 0.3
    },
    weight: 1.0
  },
  {
    id: 'b10-ethics',
    kind: 'ethics',
    prompt: 'A self-driving car must choose: swerve and hit one pedestrian, or stay straight and kill its passenger. Defend a position, then steelman the strongest opposing view. Be specific; do not retreat to "it depends".',
    reference: null,
    rubric: {
      positionTaken: 0.3,
      steelmanQuality: 0.3,
      noFalseDichotomy: 0.2,
      specificity: 0.2
    },
    weight: 1.0
  }
];

export function getBenchById(id) {
  return BENCH.find(b => b.id === id);
}

export function numericScore(value, ref, tol) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  if (typeof ref !== 'number' || isNaN(ref)) return 0;
  if (ref === 0) return Math.abs(value) < tol ? 1 : 0;
  const rel = Math.abs(value - ref) / Math.abs(ref);
  return rel <= tol ? 1 : Math.max(0, 1 - rel / tol);
}

export function includesAnyCaseInsensitive(text, words) {
  if (!text) return false;
  const l = text.toLowerCase();
  return words.some(w => l.includes(w.toLowerCase()));
}

// out-of-distribution benchmark: held-out problems used to check whether an evolved
// prompt has overfit the BENCH above. the evolution loop never sees these.
export const OOD_BENCH = [
  {
    id: 'ood-01-fair-share',
    kind: 'math',
    prompt: 'Three friends order a pizza cut into 8 equal slices. Friend A eats 1 slice, friend B eats 2, friend C eats 3. They split the bill ($40) and a $5 tip evenly. How much does each person owe?',
    reference: { A: 11.5625, B: 16.5625, C: 16.875 },
    numericTolerance: 0.05
  },
  {
    id: 'ood-02-subset-sum',
    kind: 'probability',
    prompt: 'You roll a fair 6-sided die three times. What is the probability that the three rolls can be arranged to form an increasing sequence?',
    reference: 0.278,
    numericTolerance: 0.05
  },
  {
    id: 'ood-03-monty-extended',
    kind: 'logic',
    prompt: 'You are on a game show. There are 4 doors. One has a car, three have goats. You pick door 1. The host, who knows where the car is, opens doors 3 and 4 (both goats). Should you switch to door 2? Answer YES, NO, or INDETERMINATE, give a one-sentence reason, and (if INDETERMINATE) a one-sentence counterexample.',
    reference: { answer: 'YES' },
    weight: 1.0
  },
  {
    id: 'ood-04-anagram-check',
    kind: 'code',
    prompt: 'Write a Python function `is_anagram(a, b)` that returns True iff a and b are anagrams of each other (ignoring case, spaces, and punctuation). Output ONLY the function.',
    reference: { lang: 'python', functionName: 'is_anagram', testCases: [
      { input: '"listen", "silent"', expected: true },
      { input: '"hello", "world"', expected: false },
      { input: '"Triangle", "integral"', expected: true },
      { input: '"apple", "pale"', expected: false }
    ]}
  },
  {
    id: 'ood-05-orbit',
    kind: 'science',
    prompt: 'A satellite orbits Earth at 4 times the radius of a low-Earth orbit. Using Kepler\'s third law, how does its orbital period compare to the LEO period?',
    reference: 8.0,
    numericTolerance: 0.05
  }
];
