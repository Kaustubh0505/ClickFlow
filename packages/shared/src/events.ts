import { z } from 'zod';
import { idSchema, timestampSchema } from './primitives.js';
import { actionOutcomeSchema, taskStateSchema } from './tasks.js';

const envelope = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), taskId: idSchema, taskRevision: z.number().int().nonnegative(), at: timestampSchema };

export const taskEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('task_snapshot'), task: taskStateSchema }),
  z.strictObject({ ...envelope, type: z.literal('action_outcome'), outcome: actionOutcomeSchema }),
  z.strictObject({ ...envelope, type: z.literal('task_error'), code: idSchema, message: z.string().min(1).max(4_000) }),
]).superRefine((event, ctx) => {
  if (event.type === 'task_snapshot' && (event.taskId !== event.task.id || event.taskRevision !== event.task.revision)) ctx.addIssue({ code: 'custom', message: 'Snapshot envelope must match task identity and revision' });
  if (event.type === 'task_snapshot' && event.id !== `${event.taskId}_${event.taskRevision}`) ctx.addIssue({ code: 'custom', message: 'Snapshot cursor must match task identity and revision' });
  if (event.type === 'action_outcome' && event.taskId !== event.outcome.authorization.taskId) ctx.addIssue({ code: 'custom', message: 'Event outcome must match task identity' });
});

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('clickflow-backend'),
  phase: z.literal(9),
  version: z.literal('0.2.0'),
  model: z.strictObject({ name: z.string().min(1).max(200), integration: z.literal('backend_planner'), endpoint: z.string().max(4096).optional() }),
  capabilities: z.strictObject({ planning: z.boolean(), browserExecution: z.boolean(), durableStorage: z.literal(true) }),
});

export type TaskEvent = z.infer<typeof taskEventSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
