import { z } from 'zod';
import type { Action } from './actions.js';
import { observationSchema } from './observation.js';
import { idSchema, timestampSchema } from './primitives.js';
import { verificationResultSchema, type VerificationCondition } from './verification.js';

/** A matching state can settle idempotent assignments, never an unknown click or key side effect. */
export function canReconcileFromState(action: Action, condition: VerificationCondition): boolean {
  const sameTarget = 'target' in action && 'target' in condition && JSON.stringify(action.target) === JSON.stringify(condition.target);
  if (action.type === 'type') return condition.type === 'input_value_equals' && sameTarget && condition.value === action.text;
  if (action.type === 'clear_input') return condition.type === 'input_value_equals' && sameTarget && condition.value === '';
  if (action.type === 'select_option') return condition.type === 'selected_option_equals' && sameTarget && condition.value === action.value;
  return action.type === 'navigate' && condition.type === 'url_matches' && condition.match === 'exact' && condition.url === action.url;
}

export const reconciliationReportSchema = z.strictObject({
  id: idSchema, actionId: idSchema, leaseId: idSchema,
  resolution: z.enum(['not_dispatched', 'state_verified', 'unresolved']),
  source: z.enum(['prepared_journal', 'backend_prepared', 'fresh_state']),
  observation: observationSchema, verification: verificationResultSchema.nullable(),
});
export const reconciliationEntrySchema = z.strictObject({
  id: idSchema, actionId: idSchema, at: timestampSchema, observationId: idSchema,
  resolution: z.enum(['not_dispatched', 'state_verified', 'unresolved']), explanation: z.string().min(1).max(1000),
});
export const resumeRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), observation: observationSchema,
  allowTabRelink: z.boolean().default(false),
});
export const reconcileRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), report: reconciliationReportSchema,
  allowTabRelink: z.boolean().default(false),
});
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
