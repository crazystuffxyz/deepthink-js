// parse/llmSchemas.ts
// Zod schemas for every LLM-emitted JSON shape. pair these with parseJsonSafe
// (parse/json.ts) at every call site instead of inline regex + JSON.parse.
import { z } from 'zod';

// LLMs mangle enum values ("minor revision" with a space, "Critical"
// capitalized) and one bad value kills the whole parse — run 16's domain
// expert critic failed to parse in every loop because of it. normalize
// case/whitespace before the enum check.
function normEnum(vals: readonly [string, ...string[]]) {
  return z.preprocess(
    (v) => typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, '_') : v,
    z.enum(vals)
  );
}

export const ToolCallSchema = z.object({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()).optional()
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const StepSchema = z.object({
  step: z.number(),
  action: z.string(),
  reasoning: z.string().optional()
});
export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z.object({
  steps: z.array(StepSchema).min(1)
});
export type Plan = z.infer<typeof PlanSchema>;

export const FileSpecSchema = z.object({
  path: z.string(),
  content: z.string()
});
export type FileSpec = z.infer<typeof FileSpecSchema>;

export const ArchitectureSchema = z.object({
  files: z.array(FileSpecSchema).default([]),
  entryPoint: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  startCommand: z.string().optional()
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const TestSpecSchema = z.object({
  path: z.string(),
  content: z.string()
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

export const CodeSpecSchema = z.object({
  architecture: ArchitectureSchema.optional(),
  tests: z.array(TestSpecSchema).default([])
});
export type CodeSpec = z.infer<typeof CodeSpecSchema>;

export const ClaimSchema = z.object({
  text: z.string(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional()
});
export type Claim = z.infer<typeof ClaimSchema>;

export const VerificationSchema = z.object({
  claim: z.string(),
  verdict: normEnum(['supported', 'unsupported', 'unclear']),
  rationale: z.string().optional()
});
export type Verification = z.infer<typeof VerificationSchema>;

export const DomainSchema = z.object({
  domain: z.string(),
  subdomain: z.string().default(''),
  expertPersona: z.string().default(''),
  keyRigorStandards: z.array(z.string()).default([]),
  commonErrors: z.array(z.string()).default([]),
  rationale: z.string().optional()
});
export type Domain = z.infer<typeof DomainSchema>;

export const ResearchResultSchema = z.object({
  answer: z.string(),
  sources: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional()
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

export const DebateTurnSchema = z.object({
  speaker: z.string(),
  argument: z.string(),
  confidence: z.number().min(0).max(1).optional()
});
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

export const ScoreSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string().optional()
});
export type Score = z.infer<typeof ScoreSchema>;

// permissive — fall back to a string when model doesn't shape up
export const LooseJsonSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown())
]);

// research agent schemas

export const AnswerFormatSpecSchema = z.object({
  answerType: normEnum(['list', 'comparison', 'explanation', 'recommendation', 'analysis', 'data']).default('analysis'),
  requiredFields: z.array(z.string()).default([]),
  timeConstraints: z.array(z.string()).default([]),
  entityTypes: z.array(z.string()).default([]),
  queryHints: z.array(z.string()).default([]),
  directAnswerTemplate: z.string().default('')
});
export type AnswerFormatSpec = z.infer<typeof AnswerFormatSpecSchema>;

export const PlannerQuerySchema = z.object({
  query: z.string(),
  goal: z.string().default(''),
  depth: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  topic: z.string().default('general')
});
export const PlannerPlanSchema = z.object({
  queries: z.array(PlannerQuerySchema).default([])
});
export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;

export const RankedSchema = z.object({
  ranked: z.array(z.number().int().nonnegative())
});
export type Ranked = z.infer<typeof RankedSchema>;

export const ClaimsSchema = z.object({
  claims: z.array(z.string()).default([])
});
export type Claims = z.infer<typeof ClaimsSchema>;

export const VerifyResultSchema = z.object({
  supported: z.boolean().default(false),
  confidence: z.number().min(0).max(100).default(0),
  correction: z.string().nullable().optional()
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const SourceFidelityIssueSchema = z.object({
  claimIndex: z.number().optional(),
  severity: normEnum(['critical', 'major', 'minor']).default('minor'),
  type: z.string().default('other'),
  description: z.string().default(''),
  suggestion: z.string().default('')
});
export const SourceFidelitySchema = z.object({
  issues: z.array(SourceFidelityIssueSchema).default([]),
  totalChecked: z.number().default(0),
  fidelityScore: z.number().min(0).max(100).default(100)
});
export type SourceFidelity = z.infer<typeof SourceFidelitySchema>;

export const MathLogicIssueSchema = z.object({
  location: z.string().default(''),
  severity: normEnum(['critical', 'major', 'minor']).default('minor'),
  type: z.string().default('other'),
  description: z.string().default(''),
  correction: z.string().default('')
});
export const MathLogicSchema = z.object({
  issues: z.array(MathLogicIssueSchema).default([]),
  hasMathContent: z.boolean().default(false),
  mathRigorScore: z.number().min(0).max(100).default(100)
});
export type MathLogic = z.infer<typeof MathLogicSchema>;

export const ExpertCritiqueIssueSchema = z.object({
  location: z.string().default(''),
  severity: normEnum(['critical', 'major', 'minor']).default('minor'),
  type: z.string().default('other'),
  description: z.string().default(''),
  recommendation: z.string().default('')
});
export const ExpertCritiqueSchema = z.object({
  overallAssessment: normEnum(['accept', 'major_revision', 'minor_revision', 'reject']).default('minor_revision'),
  issues: z.array(ExpertCritiqueIssueSchema).default([]),
  strengths: z.array(z.string()).default([]),
  missingTopics: z.array(z.string()).default([])
});
export type ExpertCritique = z.infer<typeof ExpertCritiqueSchema>;

export const AdversarialVulnerabilitySchema = z.object({
  claim: z.string().default(''),
  attackVector: z.string().default(''),
  severity: normEnum(['critical', 'major', 'minor']).default('minor'),
  counterEvidence: z.string().default(''),
  verdict: normEnum(['likely_wrong', 'possibly_wrong', 'weak_support', 'acceptable']).default('acceptable')
});
export const AdversarialSchema = z.object({
  vulnerabilities: z.array(AdversarialVulnerabilitySchema).default([]),
  weakestArgument: z.string().default(''),
  alternativeConclusion: z.string().default(''),
  overallVulnerabilityScore: z.number().min(0).max(100).default(0)
});
export type Adversarial = z.infer<typeof AdversarialSchema>;
