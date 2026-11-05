import { describe, expect, it } from 'vitest';
import { makeTask, makePlan, makeObservation } from '../../../../tests/fixtures.js';
import { applyRecoveryPatch } from './plan-patcher.js';

function fixture() {
  const task = makeTask(); task.plan = makePlan(); task.status = 'paused'; task.currentContext = makeObservation();
  task.plan.steps[0]!.status = 'failed';
  const patch = { basePlanVersion: 1, modifiedSteps: [{ ...task.plan.steps[0]!, status: 'pending' as const, action: { type: 'observe' as const, timeoutMs: 1000 } }], insertedSteps: [], stepUpdates: [], evidenceIds: [], replanRequired: true, completionAssessmentRequested: false, explanation: 'Resolve the failed step using fresh page state.' };
  return { task, patch };
}
describe('existing-plan recovery reducer', () => {
  it('preserves goal, IDs, pending work and exact base version', () => {
    const { task, patch } = fixture(); const original = structuredClone(task);
    const result = applyRecoveryPatch(task, patch);
    expect(task).toEqual(original); expect(result.plan.version).toBe(2);
    expect(result.plan.goal).toBe(task.originalRequest); expect(result.plan.goalCriteria).toEqual(task.plan!.goalCriteria);
    expect(result.plan.steps[1]).toEqual(task.plan!.steps[1]); expect(result.plan.steps[0]!.id).toBe('step-1');
  });
  it.each(['stale', 'completed', 'logical', 'evidence', 'cycle', 'claims', 'goal', 'budget', 'selector', 'reference', 'risk'])('rejects %s patch violations', (kind) => {
    const { task, patch } = fixture();
    if (kind === 'stale') patch.basePlanVersion = 2;
    if (kind === 'completed') task.plan!.steps[0]!.status = 'completed';
    if (kind === 'logical') patch.modifiedSteps[0]!.logicalStepId = 'reset-budget';
    if (kind === 'evidence') (patch.evidenceIds as string[]).push('invented-evidence');
    if (kind === 'cycle') patch.modifiedSteps[0]!.dependencies = ['step-2'];
    if (kind === 'claims') Object.assign(patch.modifiedSteps[0]!, { status: 'completed' });
    if (kind === 'goal') Object.assign(patch, { goal: 'Unrelated task' });
    if (kind === 'budget') task.retryCounts['step-1'] = 2;
    if (kind === 'selector') Object.assign(patch.modifiedSteps[0]!, { action: { type: 'click', target: { strategy: 'selector', selector: '#invented' } } });
    if (kind === 'reference') Object.assign(patch.modifiedSteps[0]!, { action: { type: 'click', target: { strategy: 'element_ref', ref: 'invented', observationId: task.currentContext!.id } } });
    if (kind === 'risk') task.plan!.steps[0]!.risk = 'high';
    expect(() => applyRecoveryPatch(task, patch)).toThrow();
  });
  it('prevents rewriting valid pending work', () => {
    const { task, patch } = fixture(); task.plan!.steps[0]!.status = 'pending';
    patch.modifiedSteps[0]!.id = 'step-2'; patch.modifiedSteps[0]!.logicalStepId = 'step-2';
    expect(() => applyRecoveryPatch(task, patch)).toThrow();
  });
  it('rejects inserted IDs that reset failure lineage', () => {
    const { task, patch } = fixture();
    const insert = { ...patch, modifiedSteps: [], insertedSteps: [{ afterStepId: 'step-1', step: { ...patch.modifiedSteps[0]!, id: 'replacement', logicalStepId: 'fresh-budget' } }] };
    expect(() => applyRecoveryPatch(task, insert)).toThrow('inherit');
  });
  it('inserts new IDs while preserving their original attempt lineage', () => {
    const { task, patch } = fixture(); task.retryCounts['step-1'] = 1;
    const extra = { ...patch.modifiedSteps[0]!, id: 'new-helper', dependencies: ['step-1'] };
    const finish = { ...task.plan!.steps[1]!, dependencies: ['new-helper'] };
    const replacement = { ...patch, modifiedSteps: [finish], insertedSteps: [{ afterStepId: 'step-1', step: extra }], stepUpdates: [{ stepId: 'step-1', status: 'skipped' as const, reason: 'Use the new helper.' }] };
    const result = applyRecoveryPatch(task, replacement);
    expect(result.plan.steps.map((step) => step.id)).toEqual(['step-1', 'new-helper', 'step-2']);
    expect(result.plan.steps[1]!.logicalStepId).toBe('step-1');
    task.retryCounts['step-1'] = 2; expect(() => applyRecoveryPatch(task, replacement)).toThrow('budget');
  });
  it.each(['dispatched', 'uncertain'] as const)('rejects blind replay of an unverified %s click', (dispatchStatus) => {
    const { task, patch } = fixture();
    const action = task.plan!.steps[0]!.action;
    task.actionHistory = [{ authorization: { taskId: task.id, planVersion: 1, stepId: 'step-1', actionId: 'attempt-1', attempt: 1, observationId: task.currentContext!.id, leaseId: 'lease-1', leaseExpiresAt: new Date().toISOString(), action, requiresConfirmation: false, protocolVersion: 1 }, dispatchStatus, recordedAt: new Date().toISOString(), verification: null, error: null, extraction: null }];
    Object.assign(patch.modifiedSteps[0]!, { action });
    expect(() => applyRecoveryPatch(task, patch)).toThrow();
  });
});
