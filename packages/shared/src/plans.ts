import { z } from 'zod';
import { actionSchema } from './actions.js';
import { idSchema, riskSchema, stepStatusSchema, textSchema } from './primitives.js';
import { verificationConditionSchema } from './verification.js';

export const goalCriterionSchema = z.strictObject({ id: idSchema, description: textSchema, verification: verificationConditionSchema.optional() });

export const planStepSchema = z.strictObject({
  id: idSchema,
  logicalStepId: idSchema,
  description: textSchema,
  action: actionSchema,
  preconditions: z.array(verificationConditionSchema).max(10),
  expectedResult: textSchema,
  verification: verificationConditionSchema,
  dependencies: z.array(idSchema).max(100),
  risk: riskSchema,
  status: stepStatusSchema,
  evidenceIds: z.array(idSchema).max(100),
});

export const planSchema = z.strictObject({
  goal: textSchema,
  version: z.number().int().min(1),
  goalCriteria: z.array(goalCriterionSchema).min(1).max(30),
  steps: z.array(planStepSchema).min(1).max(100),
  currentStepId: idSchema.nullable(),
}).superRefine((plan, ctx) => {
  const issue = (message: string, path: (string | number)[] = ['steps']) => ctx.addIssue({ code: 'custom', message, path });
  const ids = new Set(plan.steps.map((step) => step.id));
  if (ids.size !== plan.steps.length) issue('Step IDs must be unique');
  if (new Set(plan.goalCriteria.map((criterion) => criterion.id)).size !== plan.goalCriteria.length) issue('Goal criterion IDs must be unique', ['goalCriteria']);
  if (plan.currentStepId !== null && !ids.has(plan.currentStepId)) issue('Current step must exist', ['currentStepId']);
  const active = plan.steps.filter((step) => step.status === 'in_progress');
  if (active.length > 1) issue('Only one step may be in progress');
  if (active.length === 1 && active[0]?.id !== plan.currentStepId) issue('In-progress step must be the current step');
  for (const [index, step] of plan.steps.entries()) {
    if (new Set(step.dependencies).size !== step.dependencies.length) issue('Dependencies must be unique', ['steps', index, 'dependencies']);
    if (step.dependencies.some((id) => !ids.has(id) || id === step.id)) issue('Dependencies must exist and cannot reference the step itself', ['steps', index, 'dependencies']);
  }
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (plan.steps.some((step) => !visit(step.id))) issue('Dependencies must be acyclic');
  const finishSteps = plan.steps.filter((step) => step.action.type === 'finish');
  if (finishSteps.length !== 1 || plan.steps.at(-1)?.action.type !== 'finish') issue('A plan must end in exactly one finish step');
  const finish = finishSteps[0];
  if (finish) {
    const ancestors = new Set<string>();
    const collect = (id: string) => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) collect(dependency);
    };
    for (const dependency of finish.dependencies) collect(dependency);
    if (plan.steps.some((step) => step.id !== finish.id && !ancestors.has(step.id))) issue('Finish must depend transitively on all other steps');
  }
});

export const initialPlanSchema = planSchema.superRefine((plan, ctx) => {
  if (plan.version !== 1 || plan.currentStepId !== null || plan.steps.some((step) => step.status !== 'pending' || step.evidenceIds.length > 0)) {
    ctx.addIssue({ code: 'custom', message: 'Initial plans must be version 1, pending review, and contain no execution claims' });
  }
});

export const planPatchSchema = z.strictObject({
  basePlanVersion: z.number().int().min(1),
  modifiedSteps: z.array(planStepSchema).max(100),
  insertedSteps: z.array(z.strictObject({ afterStepId: idSchema.nullable(), step: planStepSchema })).max(100),
  stepUpdates: z.array(z.strictObject({ stepId: idSchema, status: z.enum(['skipped', 'blocked']), reason: textSchema })).max(100),
  evidenceIds: z.array(idSchema).max(100),
  replanRequired: z.boolean(),
  completionAssessmentRequested: z.boolean(),
  explanation: textSchema,
}).superRefine((patch, ctx) => {
  const ids = [...patch.modifiedSteps.map((step) => step.id), ...patch.insertedSteps.map((entry) => entry.step.id), ...patch.stepUpdates.map((update) => update.stepId)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'A patch cannot update the same step more than once' });
  if (patch.modifiedSteps.some((step) => step.status === 'completed' || step.status === 'in_progress') || patch.insertedSteps.some(({ step }) => step.status !== 'pending' || step.evidenceIds.length !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'Recovery patches cannot claim action execution or insert already-executed steps' });
  }
});

export type Plan = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanPatch = z.infer<typeof planPatchSchema>;
