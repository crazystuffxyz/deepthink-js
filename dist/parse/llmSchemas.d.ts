import { z } from 'zod';
export declare const ToolCallSchema: z.ZodObject<{
    tool: z.ZodString;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export declare const StepSchema: z.ZodObject<{
    step: z.ZodNumber;
    action: z.ZodString;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Step = z.infer<typeof StepSchema>;
export declare const PlanSchema: z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        step: z.ZodNumber;
        action: z.ZodString;
        reasoning: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Plan = z.infer<typeof PlanSchema>;
export declare const FileSpecSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
}, z.core.$strip>;
export type FileSpec = z.infer<typeof FileSpecSchema>;
export declare const ArchitectureSchema: z.ZodObject<{
    files: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>>;
    entryPoint: z.ZodOptional<z.ZodString>;
    dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    startCommand: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
export declare const TestSpecSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
}, z.core.$strip>;
export type TestSpec = z.infer<typeof TestSpecSchema>;
export declare const CodeSpecSchema: z.ZodObject<{
    architecture: z.ZodOptional<z.ZodObject<{
        files: z.ZodDefault<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            content: z.ZodString;
        }, z.core.$strip>>>;
        entryPoint: z.ZodOptional<z.ZodString>;
        dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        startCommand: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    tests: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type CodeSpec = z.infer<typeof CodeSpecSchema>;
export declare const ClaimSchema: z.ZodObject<{
    text: z.ZodString;
    source: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type Claim = z.infer<typeof ClaimSchema>;
export declare const VerificationSchema: z.ZodObject<{
    claim: z.ZodString;
    verdict: z.ZodEnum<{
        supported: "supported";
        unsupported: "unsupported";
        unclear: "unclear";
    }>;
    rationale: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Verification = z.infer<typeof VerificationSchema>;
export declare const DomainSchema: z.ZodObject<{
    domain: z.ZodString;
    subdomain: z.ZodDefault<z.ZodString>;
    expertPersona: z.ZodDefault<z.ZodString>;
    keyRigorStandards: z.ZodDefault<z.ZodArray<z.ZodString>>;
    commonErrors: z.ZodDefault<z.ZodArray<z.ZodString>>;
    rationale: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Domain = z.infer<typeof DomainSchema>;
export declare const ResearchResultSchema: z.ZodObject<{
    answer: z.ZodString;
    sources: z.ZodOptional<z.ZodArray<z.ZodString>>;
    confidence: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export declare const DebateTurnSchema: z.ZodObject<{
    speaker: z.ZodString;
    argument: z.ZodString;
    confidence: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type DebateTurn = z.infer<typeof DebateTurnSchema>;
export declare const ScoreSchema: z.ZodObject<{
    score: z.ZodNumber;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Score = z.infer<typeof ScoreSchema>;
export declare const LooseJsonSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>;
export declare const AnswerFormatSpecSchema: z.ZodObject<{
    answerType: z.ZodDefault<z.ZodEnum<{
        data: "data";
        analysis: "analysis";
        list: "list";
        comparison: "comparison";
        explanation: "explanation";
        recommendation: "recommendation";
    }>>;
    requiredFields: z.ZodDefault<z.ZodArray<z.ZodString>>;
    timeConstraints: z.ZodDefault<z.ZodArray<z.ZodString>>;
    entityTypes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    queryHints: z.ZodDefault<z.ZodArray<z.ZodString>>;
    directAnswerTemplate: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type AnswerFormatSpec = z.infer<typeof AnswerFormatSpecSchema>;
export declare const PlannerQuerySchema: z.ZodObject<{
    query: z.ZodString;
    goal: z.ZodDefault<z.ZodString>;
    depth: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>]>>;
    topic: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const PlannerPlanSchema: z.ZodObject<{
    queries: z.ZodDefault<z.ZodArray<z.ZodObject<{
        query: z.ZodString;
        goal: z.ZodDefault<z.ZodString>;
        depth: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>]>>;
        topic: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;
export declare const RankedSchema: z.ZodObject<{
    ranked: z.ZodArray<z.ZodNumber>;
}, z.core.$strip>;
export type Ranked = z.infer<typeof RankedSchema>;
export declare const ClaimsSchema: z.ZodObject<{
    claims: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type Claims = z.infer<typeof ClaimsSchema>;
export declare const VerifyResultSchema: z.ZodObject<{
    supported: z.ZodDefault<z.ZodBoolean>;
    confidence: z.ZodDefault<z.ZodNumber>;
    correction: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
export declare const SourceFidelityIssueSchema: z.ZodObject<{
    claimIndex: z.ZodOptional<z.ZodNumber>;
    severity: z.ZodDefault<z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>>;
    type: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodString>;
    suggestion: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const SourceFidelitySchema: z.ZodObject<{
    issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
        claimIndex: z.ZodOptional<z.ZodNumber>;
        severity: z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            major: "major";
            minor: "minor";
        }>>;
        type: z.ZodDefault<z.ZodString>;
        description: z.ZodDefault<z.ZodString>;
        suggestion: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    totalChecked: z.ZodDefault<z.ZodNumber>;
    fidelityScore: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type SourceFidelity = z.infer<typeof SourceFidelitySchema>;
export declare const MathLogicIssueSchema: z.ZodObject<{
    location: z.ZodDefault<z.ZodString>;
    severity: z.ZodDefault<z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>>;
    type: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodString>;
    correction: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const MathLogicSchema: z.ZodObject<{
    issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
        location: z.ZodDefault<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            major: "major";
            minor: "minor";
        }>>;
        type: z.ZodDefault<z.ZodString>;
        description: z.ZodDefault<z.ZodString>;
        correction: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    hasMathContent: z.ZodDefault<z.ZodBoolean>;
    mathRigorScore: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type MathLogic = z.infer<typeof MathLogicSchema>;
export declare const ExpertCritiqueIssueSchema: z.ZodObject<{
    location: z.ZodDefault<z.ZodString>;
    severity: z.ZodDefault<z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>>;
    type: z.ZodDefault<z.ZodString>;
    description: z.ZodDefault<z.ZodString>;
    recommendation: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const ExpertCritiqueSchema: z.ZodObject<{
    overallAssessment: z.ZodDefault<z.ZodEnum<{
        accept: "accept";
        major_revision: "major_revision";
        minor_revision: "minor_revision";
        reject: "reject";
    }>>;
    issues: z.ZodDefault<z.ZodArray<z.ZodObject<{
        location: z.ZodDefault<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            major: "major";
            minor: "minor";
        }>>;
        type: z.ZodDefault<z.ZodString>;
        description: z.ZodDefault<z.ZodString>;
        recommendation: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    strengths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    missingTopics: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type ExpertCritique = z.infer<typeof ExpertCritiqueSchema>;
export declare const AdversarialVulnerabilitySchema: z.ZodObject<{
    claim: z.ZodDefault<z.ZodString>;
    attackVector: z.ZodDefault<z.ZodString>;
    severity: z.ZodDefault<z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>>;
    counterEvidence: z.ZodDefault<z.ZodString>;
    verdict: z.ZodDefault<z.ZodEnum<{
        likely_wrong: "likely_wrong";
        possibly_wrong: "possibly_wrong";
        weak_support: "weak_support";
        acceptable: "acceptable";
    }>>;
}, z.core.$strip>;
export declare const AdversarialSchema: z.ZodObject<{
    vulnerabilities: z.ZodDefault<z.ZodArray<z.ZodObject<{
        claim: z.ZodDefault<z.ZodString>;
        attackVector: z.ZodDefault<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            major: "major";
            minor: "minor";
        }>>;
        counterEvidence: z.ZodDefault<z.ZodString>;
        verdict: z.ZodDefault<z.ZodEnum<{
            likely_wrong: "likely_wrong";
            possibly_wrong: "possibly_wrong";
            weak_support: "weak_support";
            acceptable: "acceptable";
        }>>;
    }, z.core.$strip>>>;
    weakestArgument: z.ZodDefault<z.ZodString>;
    alternativeConclusion: z.ZodDefault<z.ZodString>;
    overallVulnerabilityScore: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type Adversarial = z.infer<typeof AdversarialSchema>;
//# sourceMappingURL=llmSchemas.d.ts.map