import { z } from 'zod';
import { targetSchema } from './actions.js';
import { httpUrlSchema, idSchema, textSchema, timestampSchema } from './primitives.js';

export const verificationConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('element_visible'), target: targetSchema }),
  z.strictObject({ type: z.literal('element_hidden'), target: targetSchema }),
  z.strictObject({ type: z.literal('element_focused'), target: targetSchema }),
  z.strictObject({ type: z.literal('input_value_equals'), target: targetSchema, value: z.string().max(10_000) }),
  z.strictObject({ type: z.literal('selected_option_equals'), target: targetSchema, value: z.string().max(1_000) }),
  z.strictObject({ type: z.literal('url_matches'), url: httpUrlSchema, match: z.enum(['exact', 'prefix']) }),
  z.strictObject({ type: z.literal('text_present'), text: textSchema, target: targetSchema.optional() }),
  z.strictObject({ type: z.literal('element_count'), target: targetSchema, count: z.number().int().min(0).max(10_000) }),
  z.strictObject({ type: z.literal('scroll_position_changed'), axis: z.enum(['x', 'y']), minDelta: z.number().positive().max(10_000) }),
  z.strictObject({ type: z.literal('extracted_data_matches_schema'), outputKey: idSchema, schemaId: idSchema }),
  z.strictObject({ type: z.literal('semantic_assessment_required'), criterion: textSchema }),
]);

export const evidenceSchema = z.strictObject({
  id: idSchema,
  observationId: idSchema,
  capturedAt: timestampSchema,
  sourceUrl: httpUrlSchema,
  kind: z.enum(['dom', 'navigation', 'extraction', 'visual']),
  summary: textSchema,
});

export const verificationResultSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'unknown']),
  condition: verificationConditionSchema,
  checkedAt: timestampSchema,
  explanation: textSchema,
  evidence: z.array(evidenceSchema).max(20),
}).superRefine((value, ctx) => {
  if (value.status === 'passed' && value.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Passing verification requires evidence' });
  }
});

export type VerificationCondition = z.infer<typeof verificationConditionSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
