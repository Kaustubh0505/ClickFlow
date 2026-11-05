import { z } from 'zod';
import { planPatchSchema, type PlanPatch, type TaskState } from '@clickflow/shared';
import { planningInputSchema } from './planning-input.js';
import { recoveryPrompt } from './prompts.js';
import { ModelError } from './errors.js';
import type { ModelClient } from './model-client.js';

export class RecoveryPlanner {
  constructor(private readonly client: Pick<ModelClient, 'json'>) {}
  async update(task: TaskState, raw: unknown, signal?: AbortSignal, onRetry?: () => Promise<void>): Promise<PlanPatch> {
    const parsed = planningInputSchema.safeParse(raw);
    if (!parsed.success || parsed.data.originalRequest !== task.originalRequest || Date.now() - Date.parse(parsed.data.observation.capturedAt) > 60_000 || Date.parse(parsed.data.observation.capturedAt) - Date.now() > 5000) throw new ModelError('INVALID_CONTEXT');
    if (signal?.aborted) throw new ModelError('CANCELLED');
    const { screenshot, ...context } = parsed.data;
    const last = task.actionHistory.at(-1) ?? null;
    const output = await this.client.json(recoveryPrompt, JSON.stringify({ ...context,
      existingPlan: task.plan, completedSteps: task.plan?.steps.filter((step) => step.status === 'completed'),
      currentStep: task.plan?.steps.find((step) => step.status === 'failed' || step.status === 'blocked') ?? task.plan?.steps.find((step) => step.status === 'pending'),
      previousAction: last?.authorization.action, executionResult: last, previousVerification: last?.verification,
      actionHistory: task.actionHistory.slice(-20), verificationResults: task.verificationResults.slice(-20),
      errors: task.errors.slice(-10), remainingConstraints: { scope: 'Explicitly permitted HTTP(S) origins only. Website interactions require exact-action human review. Never automate secrets, payment fields or access-control challenges. Destination origins require separate access; never assume a grant. Preserve the existing goal and completed work.', limits: task.limits, retryCounts: task.retryCounts, modelCallCount: task.modelCallCount, recoveryAttemptCount: task.recoveryAttemptCount }, pageContentTrust: 'untrusted',
    }), z.toJSONSchema(planPatchSchema, { io: 'output' }), screenshot?.dataUrl, signal, onRetry, 'clickflow_recovery_patch');
    if (signal?.aborted) throw new ModelError('CANCELLED');
    try { return planPatchSchema.parse(JSON.parse(output)); } catch { throw new ModelError('INVALID_OUTPUT'); }
  }
}
