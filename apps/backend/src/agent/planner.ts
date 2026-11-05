import { z } from 'zod';
import { initialPlanSchema, targetSchema, type Plan } from '@clickflow/shared';
import { planningInputSchema } from './planning-input.js';
import { ModelError } from './errors.js';
import { initialPlanningPrompt } from './prompts.js';
import type { ModelClient } from './model-client.js';

const outputSchema = z.toJSONSchema(initialPlanSchema, { io: 'output' });

export function validateInitialPlan(output: unknown, input: z.infer<typeof planningInputSchema>): Plan {
  const parsed = initialPlanSchema.safeParse(output);
  if (!parsed.success || parsed.data.goal !== input.originalRequest) throw new ModelError('INVALID_OUTPUT');
  const plan = parsed.data;
  const earlier = new Set<string>();
  const logicalIds = new Set<string>();
  for (const step of plan.steps) {
    if (step.dependencies.some((id) => !earlier.has(id)) || logicalIds.has(step.logicalStepId)) throw new ModelError('INVALID_OUTPUT');
    earlier.add(step.id); logicalIds.add(step.logicalStepId);
  }
  // Traverse every target location, including preconditions and verification.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('strategy' in value) {
      const target = targetSchema.parse(value);
      if (target.strategy === 'selector') throw new ModelError('INVALID_OUTPUT');
      if (target.strategy === 'element_ref' && (target.observationId !== input.observation.id || !input.observation.elements.some((element) => element.ref === target.ref))) throw new ModelError('INVALID_OUTPUT');
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(plan);
  for (const criterion of plan.goalCriteria) {
    const condition = criterion.verification;
    if (condition && 'target' in condition && condition.target && ['element_ref', 'semantic', 'selector'].includes(condition.target.strategy)) throw new ModelError('INVALID_OUTPUT');
  }
  return plan;
}

export class Planner {
  constructor(private readonly client: Pick<ModelClient, 'initialPlan'>) {}
  async generate(rawInput: unknown, signal?: AbortSignal, onRetry?: () => Promise<void>): Promise<Plan> {
    const result = planningInputSchema.safeParse(rawInput);
    if (!result.success) throw new ModelError('INVALID_CONTEXT');
    const input = result.data;
    const age = Date.now() - Date.parse(input.observation.capturedAt);
    if (age > 60_000 || age < -5_000) throw new ModelError('INVALID_CONTEXT');
    if (signal?.aborted) throw new ModelError('CANCELLED');
    const { screenshot, ...context } = input;
    const raw = await this.client.initialPlan(initialPlanningPrompt,
      JSON.stringify({ ...context, pageContentTrust: 'untrusted', screenshotOmitted: !screenshot }), outputSchema, screenshot?.dataUrl, signal, onRetry);
    if (signal?.aborted) throw new ModelError('CANCELLED');
    let output: unknown;
    try { output = JSON.parse(raw); } catch { throw new ModelError('INVALID_OUTPUT'); }
    return validateInitialPlan(output, input);
  }
}
