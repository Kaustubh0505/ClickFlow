import { z } from 'zod';
import { taskExecutionCommandSchema } from './task-protocol.js';
import { taskStateSchema } from './tasks.js';
import { fixtureActionResultSchema, browserToolResponseSchema, probeErrorSchema } from './browser-tools.js';
import { reconciliationReportSchema } from './resume.js';
import { idSchema, timestampSchema } from './primitives.js';

export const journalPhaseSchema = z.enum(['prepared', 'dispatching', 'uncertain', 'outcome_ready', 'reconciliation_ready', 'acknowledged']);
export const actionJournalSchema = z.strictObject({
  version: z.literal(1), command: taskExecutionCommandSchema,
  browser: z.strictObject({ tabId: z.number().int().nonnegative(), windowId: z.number().int().nonnegative(), documentId: idSchema }),
  phase: journalPhaseSchema, updatedAt: timestampSchema,
  allowTabRelink: z.boolean().default(false),
  result: fixtureActionResultSchema.nullable(), report: reconciliationReportSchema.nullable(),
}).superRefine((journal, ctx) => {
  if ((journal.result && journal.result.actionId !== journal.command.authorization.actionId)
    || (journal.report && journal.report.actionId !== journal.command.authorization.actionId)
    || (journal.phase === 'outcome_ready' && !journal.result) || (journal.phase === 'reconciliation_ready' && !journal.report)) ctx.addIssue({ code: 'custom', message: 'Journal phase and action identity must agree' });
});
export const durableExecutionSchema = z.strictObject({
  version: z.literal(1), active: actionJournalSchema.nullable(),
  receipts: z.array(z.strictObject({ taskId: idSchema, actionId: idSchema, phase: z.enum(['acknowledged', 'cancelled_unresolved']), at: timestampSchema })).max(200),
  cancellations: z.array(z.strictObject({ taskId: idSchema, requestedAt: timestampSchema, acknowledged: z.boolean() })).max(100),
  lastError: probeErrorSchema.nullable(),
});
export const taskCheckpointSchema = z.strictObject({ task: taskStateSchema, eventId: z.string().max(128), savedAt: timestampSchema }).superRefine((value, ctx) => {
  if (value.eventId !== `${value.task.id}_${value.task.revision}`) ctx.addIssue({ code: 'custom', message: 'Checkpoint cursor must match its task revision' });
});
export const taskControlCommandSchema = z.discriminatedUnion('kind', [
  taskExecutionCommandSchema.extend({ kind: z.literal('checkpoint_task_action') }),
  z.strictObject({ kind: z.literal('stop_task'), taskId: idSchema }),
  z.strictObject({ kind: z.literal('persist_task_checkpoint'), task: taskStateSchema }),
  z.strictObject({ kind: z.literal('record_preflight_failure'), taskId: idSchema, actionId: idSchema, error: probeErrorSchema }),
  z.strictObject({ kind: z.literal('sync_task'), taskId: idSchema, resume: z.boolean().default(false), allowTabRelink: z.boolean().default(false) }),
]);
export const taskControlResponseSchema = z.strictObject({
  ok: z.boolean(), task: taskStateSchema.nullable(), browser: browserToolResponseSchema.nullable(),
  journal: durableExecutionSchema.nullable(), error: probeErrorSchema.nullable(),
});
export type ActionJournal = z.infer<typeof actionJournalSchema>;
export type DurableExecution = z.infer<typeof durableExecutionSchema>;
export type TaskControlCommand = z.infer<typeof taskControlCommandSchema>;
export type TaskControlResponse = z.infer<typeof taskControlResponseSchema>;
