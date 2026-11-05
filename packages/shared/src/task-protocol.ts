import { z } from 'zod';
import { actionEnvelopeSchema, taskStateSchema } from './tasks.js';
import { observationSchema } from './observation.js';
import { idSchema } from './primitives.js';
import { verificationConditionSchema } from './verification.js';
import { fixtureActionResultSchema } from './browser-tools.js';
import { approvalSchema } from './safety.js';

export const startTaskRequestSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), observation: observationSchema });
export const activeTaskResponseSchema = z.strictObject({ task: taskStateSchema.nullable() });
export const authorizeRequestSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), actionId: idSchema });
export const submitOutcomeSchema = z.strictObject({ result: fixtureActionResultSchema });
export const taskExecutionCommandSchema = z.strictObject({ kind: z.literal('execute_task_action'), sessionId: idSchema, authorization: actionEnvelopeSchema, verification: verificationConditionSchema, approval: approvalSchema.optional() });
export type TaskExecutionCommand = z.infer<typeof taskExecutionCommandSchema>;
