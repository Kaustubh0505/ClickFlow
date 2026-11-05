import { z } from 'zod';
import { completionProposalSchema, containsSensitiveText, type CompletionProposal, type TaskState } from '@clickflow/shared';
import { completionInputSchema } from './planning-input.js';
import { completionPrompt } from './prompts.js';
import { ModelError } from './errors.js';
import { evidenceCatalog } from '../execution/completion-checker.js';
import type { ModelClient } from './model-client.js';

export class CompletionAssessor {
  constructor(private readonly client: Pick<ModelClient, 'json'>) {}
  async assess(task: TaskState, raw: unknown, signal?: AbortSignal, onRetry?: () => Promise<void>): Promise<CompletionProposal> {
    const parsed = completionInputSchema.safeParse(raw);
    if (!parsed.success || parsed.data.originalRequest !== task.originalRequest || containsSensitiveText(JSON.stringify(task.plan)) || Math.abs(Date.now() - Date.parse(parsed.data.observation.capturedAt)) > 30_000) throw new ModelError('INVALID_CONTEXT');
    if (signal?.aborted) throw new ModelError('CANCELLED');
    const { screenshot, goalChecks, ...context } = parsed.data;
    const output = await this.client.json(completionPrompt, JSON.stringify({ ...context, existingPlan: task.plan,
      evidenceCatalog: evidenceCatalog(task, goalChecks, context.observation), remainingConstraints: { limits: task.limits, modelCallCount: task.modelCallCount },
      pageContentTrust: 'untrusted', resultTrust: 'proposal_requires_backend_validation',
    }), z.toJSONSchema(completionProposalSchema, { io: 'output' }), screenshot?.dataUrl, signal, onRetry, 'clickflow_completion_assessment');
    if (signal?.aborted) throw new ModelError('CANCELLED');
    try { return completionProposalSchema.parse(JSON.parse(output)); } catch { throw new ModelError('INVALID_OUTPUT'); }
  }
}
