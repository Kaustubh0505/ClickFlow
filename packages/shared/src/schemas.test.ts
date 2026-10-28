import { describe, expect, it } from 'vitest';
import {
  actionSchema, completionResultSchema, httpUrlSchema, initialPlanSchema,
  observationSchema, planPatchSchema, planSchema, taskEventSchema,
  taskStateSchema, verificationResultSchema,
} from './index.js';
import { capturedAt, evidence, makeObservation, makePlan, makeTask, target } from '../../../tests/fixtures.js';

describe('strict action contracts', () => {
  it.each([
    { type: 'observe' }, { type: 'navigate', url: 'https://example.com' }, { type: 'click', target },
    { type: 'type', target, text: 'laptops' }, { type: 'clear_input', target },
    { type: 'select_option', target, value: 'price' }, { type: 'scroll', direction: 'down', pixels: 300 },
    { type: 'press_key', target, key: 'Enter' }, { type: 'wait' }, { type: 'go_back' },
    { type: 'go_forward' }, { type: 'extract_text', target, outputKey: 'products' }, { type: 'finish' },
  ])('accepts the supported $type action', (action) => {
    expect(actionSchema.parse(action).timeoutMs).toBe(10_000);
  });

  it.each([
    { type: 'execute_script', code: 'alert(1)' }, { type: 'click' },
    { type: 'click', target, code: 'alert(1)' }, { type: 'type', target },
    { type: 'scroll', direction: 'down', pixels: -1 }, { type: 'wait', timeoutMs: 0 },
    { type: 'click', target: { strategy: 'coordinates', x: 1, y: 1 } },
    { type: 'press_key', target, key: 'arbitrary-script' },
  ])('rejects unsafe or invalid input %#', (action) => {
    expect(actionSchema.safeParse(action).success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'https://user:password@example.com'])('rejects URL %s', (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('complete plan contracts', () => {
  it('accepts an ordered complete plan before review', () => expect(initialPlanSchema.safeParse(makePlan()).success).toBe(true));
  it('rejects duplicate step IDs', () => {
    const plan = makePlan();
    plan.steps[1]!.id = 'step-1';
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('rejects missing dependencies', () => {
    const plan = makePlan();
    plan.steps[1]!.dependencies = ['missing'];
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('rejects dependency cycles', () => {
    const plan = makePlan();
    plan.steps[0]!.dependencies = ['step-2'];
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('requires finish to depend on all other work', () => {
    const plan = makePlan();
    plan.steps[1]!.dependencies = [];
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('rejects plans with no finish step', () => {
    const plan = makePlan();
    plan.steps.pop();
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('rejects invalid current-step references', () => expect(planSchema.safeParse({ ...makePlan(), currentStepId: 'missing' }).success).toBe(false));
  it('rejects multiple in-progress steps', () => {
    const plan = makePlan();
    plan.currentStepId = 'step-1';
    plan.steps.forEach((step) => { step.status = 'in_progress'; });
    expect(planSchema.safeParse(plan).success).toBe(false);
  });
  it('initial plans cannot claim completed work', () => {
    const plan = makePlan();
    plan.steps[0]!.status = 'completed';
    expect(initialPlanSchema.safeParse(plan).success).toBe(false);
  });
  it('permits semantic targets for unobserved pages', () => {
    const plan = makePlan();
    plan.steps[0]!.action = actionSchema.parse({ type: 'click', target: { strategy: 'semantic', description: 'Search field on the next page' } });
    expect(initialPlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe('evidence and bounded observations', () => {
  const verification = () => ({ status: 'passed', condition: { type: 'element_focused', target }, checkedAt: capturedAt, explanation: 'Focus matches', evidence: [evidence] });
  it('accepts evidence-backed verification', () => expect(verificationResultSchema.safeParse(verification()).success).toBe(true));
  it('rejects passing verification without evidence', () => expect(verificationResultSchema.safeParse({ ...verification(), evidence: [] }).success).toBe(false));
  it('accepts unknown verification without claiming success', () => expect(verificationResultSchema.safeParse({ ...verification(), status: 'unknown', evidence: [] }).success).toBe(true));
  it('rejects oversized page text', () => expect(observationSchema.safeParse({ ...makeObservation(), visibleText: 'x'.repeat(20_001) }).success).toBe(false));
  it('requires a screenshot omission reason', () => expect(observationSchema.safeParse({ ...makeObservation(), screenshot: { status: 'omitted' } }).success).toBe(false));
  it('rejects arbitrary raw screenshot fields', () => expect(observationSchema.safeParse({ ...makeObservation(), screenshot: { status: 'omitted', reason: 'Unneeded', dataUrl: 'secret' } }).success).toBe(false));
  it('rejects password or token fields in element metadata', () => {
    const element = { ref: 'element-1', role: 'textbox', name: 'Password', tagName: 'input', visible: true, enabled: true, bounds: { x: 0, y: 0, width: 10, height: 10 }, value: 'secret' };
    expect(observationSchema.safeParse({ ...makeObservation(), elements: [element] }).success).toBe(false);
  });
  it('requires evidence for completion criteria', () => {
    expect(completionResultSchema.safeParse({ status: 'completed', summary: 'Done', criteria: [{ criterionId: 'criterion-1', status: 'met', evidenceIds: [] }], evidence: [] }).success).toBe(false);
  });
  it('rejects nonexistent completion evidence', () => {
    expect(completionResultSchema.safeParse({ status: 'completed', summary: 'Done', criteria: [{ criterionId: 'criterion-1', status: 'met', evidenceIds: ['missing'] }], evidence: [evidence] }).success).toBe(false);
  });
});

describe('task, patch, and event contracts', () => {
  const patch = () => ({ basePlanVersion: 1, modifiedSteps: [], insertedSteps: [], stepUpdates: [], evidenceIds: [], replanRequired: false, completionAssessmentRequested: false, explanation: 'Remaining steps are valid' });
  it('accepts a pending planning task', () => expect(taskStateSchema.safeParse(makeTask()).success).toBe(true));
  it('rejects ready state without a plan', () => expect(taskStateSchema.safeParse({ ...makeTask(), status: 'ready' }).success).toBe(false));
  it('rejects a changed original goal', () => expect(taskStateSchema.safeParse({ ...makeTask(), status: 'ready', plan: { ...makePlan(), goal: 'Another task' } }).success).toBe(false));
  it('rejects completion without a result', () => expect(taskStateSchema.safeParse({ ...makeTask(), status: 'completed', plan: makePlan() }).success).toBe(false));
  it('rejects time moving backwards', () => expect(taskStateSchema.safeParse({ ...makeTask(), updatedAt: '2026-10-27T12:00:00Z' }).success).toBe(false));
  it('accepts a well-formed no-change patch', () => expect(planPatchSchema.safeParse(patch()).success).toBe(true));
  it('rejects recovery patches that claim execution', () => {
    expect(planPatchSchema.safeParse({ ...patch(), modifiedSteps: [{ ...makePlan().steps[0], status: 'completed' }] }).success).toBe(false);
  });
  it('rejects conflicting updates within a patch', () => {
    expect(planPatchSchema.safeParse({ ...patch(), stepUpdates: [{ stepId: 'step-1', status: 'skipped', reason: 'Not needed' }, { stepId: 'step-1', status: 'blocked', reason: 'Cannot continue' }] }).success).toBe(false);
  });
  it('rejects unrelated event envelope identity', () => {
    expect(taskEventSchema.safeParse({ id: 'event-1', taskId: 'another-task', taskRevision: 0, at: capturedAt, type: 'task_snapshot', task: makeTask() }).success).toBe(false);
  });
});
