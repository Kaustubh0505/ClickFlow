import { z } from 'zod';
import { actionSchema } from './actions.js';
import { observationSchema } from './observation.js';
import { planPatchSchema, planSchema } from './plans.js';
import { executionLimitsSchema, idSchema, taskStatusSchema, textSchema, timestampSchema } from './primitives.js';
import { evidenceSchema, verificationResultSchema } from './verification.js';

export const actionEnvelopeSchema = z.strictObject({
  taskId: idSchema,
  planVersion: z.number().int().min(1),
  stepId: idSchema,
  actionId: idSchema,
  attempt: z.number().int().min(1).max(5),
  observationId: idSchema,
  leaseId: idSchema,
  leaseExpiresAt: timestampSchema,
  action: actionSchema,
});

export const actionOutcomeSchema = z.strictObject({
  authorization: actionEnvelopeSchema,
  dispatchStatus: z.enum(['not_dispatched', 'dispatched', 'uncertain']),
  recordedAt: timestampSchema,
  verification: verificationResultSchema.nullable(),
  error: z.strictObject({ code: idSchema, message: textSchema }).nullable(),
}).superRefine((outcome, ctx) => {
  if (outcome.dispatchStatus === 'not_dispatched' && outcome.verification?.status === 'passed') {
    ctx.addIssue({ code: 'custom', message: 'An undispatched action cannot claim successful verification' });
  }
});

export const completionResultSchema = z.strictObject({
  status: z.enum(['completed', 'partial', 'blocked', 'failed']),
  summary: textSchema,
  criteria: z.array(z.strictObject({ criterionId: idSchema, status: z.enum(['met', 'unmet', 'unknown']), evidenceIds: z.array(idSchema).max(100) })).max(30),
  evidence: z.array(evidenceSchema).max(200),
}).superRefine((result, ctx) => {
  const ids = new Set(result.evidence.map((evidence) => evidence.id));
  if (ids.size !== result.evidence.length) ctx.addIssue({ code: 'custom', message: 'Evidence IDs must be unique' });
  if (new Set(result.criteria.map((criterion) => criterion.criterionId)).size !== result.criteria.length) ctx.addIssue({ code: 'custom', message: 'Completion criterion IDs must be unique' });
  for (const criterion of result.criteria) {
    if (criterion.evidenceIds.some((id) => !ids.has(id)) || (criterion.status === 'met' && criterion.evidenceIds.length === 0)) ctx.addIssue({ code: 'custom', message: 'Met criteria require existing evidence references' });
  }
  if (result.status === 'completed' && (result.criteria.length === 0 || result.criteria.some((criterion) => criterion.status !== 'met'))) ctx.addIssue({ code: 'custom', message: 'Completion requires all criteria to be met with evidence' });
});

export const taskStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  revision: z.number().int().min(0),
  originalRequest: textSchema,
  status: taskStatusSchema,
  initialContext: observationSchema.nullable(),
  currentContext: observationSchema.nullable(),
  plan: planSchema.nullable(),
  actionHistory: z.array(actionOutcomeSchema).max(200),
  verificationResults: z.array(verificationResultSchema).max(200),
  recoveryHistory: z.array(z.strictObject({ at: timestampSchema, patch: planPatchSchema })).max(20),
  errors: z.array(z.strictObject({ at: timestampSchema, code: idSchema, message: textSchema })).max(200),
  retryCounts: z.record(idSchema, z.number().int().min(0).max(5)),
  limits: executionLimitsSchema,
  cancellationRequested: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  result: completionResultSchema.nullable(),
}).superRefine((task, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) issue('Updated timestamp cannot precede creation');
  if (!['planning', 'cancelled', 'failed', 'paused'].includes(task.status) && task.plan === null) issue('Task status requires a plan');
  if (task.plan && task.plan.goal !== task.originalRequest) issue('Plan must preserve the original user goal');
  if (task.actionHistory.some((outcome) => outcome.authorization.taskId !== task.id)) issue('Action history must belong to this task');
  if (new Set(task.actionHistory.map((outcome) => outcome.authorization.actionId)).size !== task.actionHistory.length) issue('Action outcomes must have unique action IDs');
  if (task.status === 'completed') {
    if (task.result?.status !== 'completed' || !task.plan || task.plan.steps.some((step) => !['completed', 'skipped'].includes(step.status))) issue('Completed task requires verified results and no unfinished steps');
    const resultIds = new Set(task.result?.criteria.map((criterion) => criterion.criterionId));
    if (task.plan && (resultIds.size !== task.plan.goalCriteria.length || task.plan.goalCriteria.some((criterion) => !resultIds.has(criterion.id)))) issue('Completion must assess every original goal criterion');
  }
});

export type TaskState = z.infer<typeof taskStateSchema>;
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
