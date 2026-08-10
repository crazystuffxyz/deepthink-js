import { z } from 'zod';
type CallChat = (msgs: unknown[], stream: boolean, onChunk: null, opts: Record<string, unknown>) => Promise<{
    content: string;
}>;
declare function debateRound(callChat: CallChat, topic: string, persona: 'A' | 'B', priorText: string, opts: Record<string, unknown>): Promise<string>;
declare const VerdictSchema: z.ZodObject<{
    winner: z.ZodEnum<{
        A: "A";
        B: "B";
        tie: "tie";
    }>;
    synthesis: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare function judge(callChat: CallChat, topic: string, textA: string, textB: string, opts: Record<string, unknown>): Promise<z.infer<typeof VerdictSchema>>;
export declare function runDebate(callChat: CallChat, input: unknown, opts?: {
    debateRounds?: number;
    [k: string]: unknown;
}): Promise<{
    topic: string;
    agentA: string;
    agentB: string;
    verdict: z.infer<typeof VerdictSchema>;
    answer: string;
}>;
export { debateRound, judge };
//# sourceMappingURL=personaDebate.d.ts.map