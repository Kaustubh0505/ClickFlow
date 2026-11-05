import { describe, expect, it, vi } from 'vitest';
import { makeTask, makePlan, makeObservation } from '../../../../tests/fixtures.js';
import { RecoveryPlanner } from './recovery.js';

describe('recovery prompt and structured update', () => {
  it('sends the existing plan, goal, history, constraints and fresh untrusted context', async () => {
    const task = makeTask(); task.plan = makePlan();
    const patch = { basePlanVersion: 1, modifiedSteps: [], insertedSteps: [], stepUpdates: [], evidenceIds: [], replanRequired: false, completionAssessmentRequested: false, explanation: 'No changes needed.' };
    const json = vi.fn().mockResolvedValue(JSON.stringify(patch));
    const observation = { ...makeObservation(), capturedAt: new Date().toISOString() };
    expect(await new RecoveryPlanner({ json }).update(task, { originalRequest: task.originalRequest, observation })).toEqual(patch);
    const content = JSON.parse(json.mock.calls[0]![1] as string);
    expect(content.existingPlan).toEqual(task.plan); expect(content.originalRequest).toBe(task.originalRequest);
    expect(content.pageContentTrust).toBe('untrusted'); expect(content.remainingConstraints.retryCounts).toEqual(task.retryCounts);
    expect(content.remainingConstraints.scope).toContain('exact-action human review');
    expect(content.verificationResults).toEqual([]);
  });
  it('rejects malformed output and goal changes', async () => {
    const task = makeTask(); task.plan = makePlan(); const observation = { ...makeObservation(), capturedAt: new Date().toISOString() };
    const planner = new RecoveryPlanner({ json: vi.fn().mockResolvedValue('{broken') });
    await expect(planner.update(task, { originalRequest: task.originalRequest, observation })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(planner.update(task, { originalRequest: 'Another goal', observation })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  });
  it('rejects a response arriving after cancellation', async () => {
    const task = makeTask(); const abort = new AbortController();
    const json = vi.fn(async () => { abort.abort(); return '{}'; });
    await expect(new RecoveryPlanner({ json }).update(task, { originalRequest: task.originalRequest, observation: { ...makeObservation(), capturedAt: new Date().toISOString() } }, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
