import { z } from 'zod';
import { idSchema } from './primitives.js';
import { verificationConditionSchema, verificationResultSchema } from './verification.js';

export const citationSchema = z.strictObject({ evidenceId: idSchema, quote: z.string().trim().min(3).max(4000) });
/** A model may cite recorded facts, never supply its own evidence objects or final summary. */
export const completionProposalSchema = z.strictObject({
  status: z.enum(['completed', 'partial', 'blocked']),
  criteria: z.array(z.strictObject({
    criterionId: idSchema, status: z.enum(['met', 'unmet', 'unknown']),
    evidenceIds: z.array(idSchema).max(100), citations: z.array(citationSchema).max(100),
  })).min(1).max(30),
});
export type CompletionProposal = z.infer<typeof completionProposalSchema>;
export const goalCheckRequestSchema = z.strictObject({ criterionId: idSchema, condition: verificationConditionSchema });
export const goalCheckSchema = z.strictObject({ criterionId: idSchema, verification: verificationResultSchema });
export type GoalCheck = z.infer<typeof goalCheckSchema>;
export function needsFreshGoalCheck(condition: z.infer<typeof verificationConditionSchema>) {
  return !['extracted_data_matches_schema', 'scroll_position_changed', 'semantic_assessment_required'].includes(condition.type);
}
