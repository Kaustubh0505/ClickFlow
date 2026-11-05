import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_URL, type FixtureActionResult, type ReconciliationReport, type TaskState } from '@clickflow/shared';
import { makeObservation, makePlan } from '../../../../tests/fixtures.js';
import { AtomicFileTaskStore } from '../state/atomic-file-task-store.js';
import { TaskService } from './task-service.js';

let directory: string; let store: AtomicFileTaskStore; let tasks: TaskService;
const observation = () => ({ ...makeObservation(), url: FIXTURE_URL, capturedAt: new Date().toISOString() });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'clickflow-resume-')); store = new AtomicFileTaskStore(directory); await store.initialize(); tasks = new TaskService(store, { generate: async () => makePlan() }); });
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
async function ready() {
  await tasks.create('resume-task', { originalRequest: makePlan().goal, observation: observation() });
  await vi.waitFor(async () => expect((await tasks.get('resume-task')).status).toBe('ready')); return tasks.get('resume-task');
}
async function prepared(type: 'click' | 'type' = 'click', claim = false) {
  const plan = makePlan();
  if (type === 'type') { const target = plan.steps[0]!.action.type === 'click' ? plan.steps[0]!.action.target : { strategy: 'selector' as const, selector: '#fixture-search' };
    plan.steps[0]!.action = { type: 'type', target, text: 'laptops', timeoutMs: 1000 }; plan.steps[0]!.verification = { type: 'input_value_equals', target, value: 'laptops' }; }
  tasks = new TaskService(store, { generate: async () => plan });
  let task = await ready(); task = await tasks.start(task.id, task.revision, observation()); task = await tasks.authorize(task.id, task.revision, 'action-resume');
  return claim ? tasks.claim(task.id, task.pendingAction!.authorization.actionId, task.pendingAction!.authorization.leaseId) : task;
}
function report(task: TaskState, resolution: ReconciliationReport['resolution']): ReconciliationReport {
  const pending = task.pendingAction!; const fresh = { ...observation(), id: 'fresh-reconciliation', documentId: 'rebound-document' };
  return { id: 'report-1', actionId: pending.authorization.actionId, leaseId: pending.authorization.leaseId, resolution,
    source: resolution === 'not_dispatched' ? 'prepared_journal' : 'fresh_state', observation: fresh,
    verification: resolution === 'state_verified' ? { status: 'passed', condition: pending.verification, checkedAt: fresh.capturedAt,
      explanation: 'The exact desired input state matches; the original action was not repeated.', evidence: [{ id: 'fresh-evidence', kind: 'dom', observationId: fresh.id, sourceUrl: fresh.url, capturedAt: fresh.capturedAt, summary: 'Exact desired value observed.' }] } : null };
}
function outcome(task: TaskState): FixtureActionResult {
  const pending = task.pendingAction!; const fresh = { ...observation(), id: 'outcome-observation' };
  return { actionId: pending.authorization.actionId, actionType: pending.authorization.action.type, dispatchStatus: 'dispatched', recordedAt: fresh.capturedAt,
    observation: fresh, extraction: null, error: null, verification: { status: 'passed', condition: pending.verification, checkedAt: fresh.capturedAt,
      explanation: 'The fixture predicate matched.', evidence: [{ id: 'outcome-evidence', observationId: fresh.id, kind: 'dom', sourceUrl: fresh.url, capturedAt: fresh.capturedAt, summary: 'Predicate matched after dispatch.' }] } };
}
describe('interruption reconciliation and fresh resume', () => {
  it('a backend-unclaimed protocol-2 action is provably undispatched even if the extension never received authorization', async () => {
    let task = await prepared(); const proof = { ...report(task, 'not_dispatched'), source: 'backend_prepared' as const };
    task = await tasks.reconcile(task.id, task.revision, proof); expect(task.plan!.steps[0]!.status).toBe('pending'); expect(task.dispatchClaims).toHaveLength(0);
  });
  it('dispatch claims are durable and idempotent; they cannot be downgraded to no-dispatch proof', async () => {
    let task = await prepared(); const auth = task.pendingAction!.authorization;
    await expect(tasks.outcome(task.id, outcome(task))).rejects.toMatchObject({ code: 'NO_DISPATCH_CLAIM' });
    task = await tasks.claim(task.id, auth.actionId, auth.leaseId); expect((await tasks.claim(task.id, auth.actionId, auth.leaseId)).revision).toBe(task.revision);
    await expect(tasks.reconcile(task.id, task.revision, report(task, 'not_dispatched'))).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    const stopped = await tasks.stop(task.id); await expect(tasks.claim(stopped.id, auth.actionId, auth.leaseId)).rejects.toMatchObject({ code: 'NOT_READY' });
  });
  it('checkpoints restart once, blocks Start, then explicitly re-observes without executing', async () => {
    let task = await ready(); task = await tasks.start(task.id, task.revision, observation());
    await tasks.initialize(); task = await tasks.get(task.id); expect(task.resumeRequired).toBe(true);
    await tasks.initialize(); expect((await tasks.get(task.id)).revision).toBe(task.revision);
    await expect(tasks.start(task.id, task.revision, observation())).rejects.toMatchObject({ code: 'RESUME_REQUIRED' });
    task = await tasks.resume(task.id, task.revision, { ...observation(), documentId: 'fresh-document' });
    expect(task.resumeRequired).toBe(false); expect(task.plan!.steps.map((step) => step.status)).toEqual(['pending', 'pending']); expect(task.actionHistory).toHaveLength(0);
    expect((await tasks.start(task.id, task.revision, { ...task.currentContext!, capturedAt: new Date().toISOString() })).status).toBe('executing');
  });
  it('proven pre-dispatch interruption returns the same step to pending and retains its budget', async () => {
    let task = await prepared(); const original = structuredClone(task.plan!.steps[1]); const proof = report(task, 'not_dispatched');
    task = await tasks.reconcile(task.id, task.revision, proof);
    expect(task.pendingAction).toBeNull(); expect(task.plan!.steps[0]!.status).toBe('pending'); expect(task.plan!.steps[1]).toEqual(original);
    expect(task.retryCounts['step-1']).toBe(1); expect(task.actionHistory[0]!.dispatchStatus).toBe('not_dispatched');
    expect((await tasks.reconcile(task.id, 0, proof)).revision).toBe(task.revision);
    task = await tasks.start(task.id, task.revision, { ...proof.observation, capturedAt: new Date().toISOString() }); task = await tasks.authorize(task.id, task.revision, 'review-again'); expect(task.pendingAction!.authorization.attempt).toBe(2);
  });
  it('only matching state of an idempotent assignment can settle an uncertain dispatch', async () => {
    let task = await prepared('type', true); const proof = report(task, 'state_verified');
    task = await tasks.reconcile(task.id, task.revision, proof);
    expect(task.plan!.steps[0]!.status).toBe('completed'); expect(task.actionHistory[0]!.dispatchStatus).toBe('uncertain');
    expect(task.actionHistory[0]!.verification!.evidence[0]!.observationId).toBe(proof.observation.id);
    expect(task.reconciliationHistory[0]!.explanation).toContain('not repeated'); expect(task.modelCallCount).toBe(1);
    await expect(tasks.start(task.id, task.revision, { ...proof.observation, capturedAt: new Date().toISOString() })).resolves.toMatchObject({ status: 'executing' });
  });
  it('a matching page predicate never proves an unknown click or key side effect occurred', async () => {
    let task = await prepared('click', true);
    await expect(tasks.reconcile(task.id, task.revision, report(task, 'state_verified'))).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    task = await tasks.reconcile(task.id, task.revision, report(task, 'unresolved'));
    expect(task.pendingAction).not.toBeNull(); expect(task.resumeRequired).toBe(true); expect(task.plan!.steps[0]!.status).toBe('in_progress');
    await expect(tasks.authorize(task.id, task.revision, 'do-not-repeat')).rejects.toMatchObject({ code: 'NOT_READY' });
  });
  it.each(['source', 'predicate', 'evidence', 'action', 'lease', 'revision', 'age'] as const)('rejects a changed or stale reconciliation %s', async (kind) => {
    const task = await prepared('type', kind !== 'source'); const proof = report(task, kind === 'source' ? 'not_dispatched' : 'state_verified');
    if (kind === 'source') proof.source = 'fresh_state';
    if (kind === 'predicate') proof.verification!.condition = { type: 'text_present', text: 'unrelated' };
    if (kind === 'evidence') proof.verification!.evidence[0]!.observationId = 'unrelated';
    if (kind === 'action') proof.actionId = 'another-action'; if (kind === 'lease') proof.leaseId = 'another-lease';
    if (kind === 'age') proof.observation.capturedAt = '2020-01-01T00:00:00Z';
    await expect(tasks.reconcile(task.id, kind === 'revision' ? task.revision - 1 : task.revision, proof)).rejects.toThrow();
    expect((await tasks.get(task.id)).pendingAction).not.toBeNull();
  });
  it('requires explicit exact-URL relinking when a browser restart changed tab IDs', async () => {
    let task = await ready(); const fresh = { ...observation(), tabId: 400, windowId: 400, documentId: 'new-browser-document' };
    await expect(tasks.resume(task.id, task.revision, fresh)).rejects.toMatchObject({ code: 'TAB_RELINK_REQUIRED' });
    await expect(tasks.resume(task.id, task.revision, { ...fresh, url: 'https://different.example' }, true)).rejects.toMatchObject({ code: 'TAB_RELINK_REQUIRED' });
    task = await tasks.resume(task.id, task.revision, fresh, true); expect(task.currentContext!.tabId).toBe(400); expect(task.initialContext!.tabId).toBe(1);
  });
  it('a changed URL pauses for plan recovery rather than assuming the old plan is valid', async () => {
    let task = await ready(); task = await tasks.resume(task.id, task.revision, { ...observation(), url: 'https://permitted.example/page' });
    expect(task.planNeedsRecovery).toBe(true); await expect(tasks.start(task.id, task.revision, task.currentContext!)).rejects.toMatchObject({ code: 'RESUME_REQUIRED' });
  });
  it('accepts a delayed durable result using its original evidence time and does not replay it', async () => {
    let task = await prepared('click', true); const saved = outcome(task);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120_000);
    task = await tasks.outcome(task.id, saved); expect(task.plan!.steps[0]!.status).toBe('completed'); expect(task.actionHistory).toHaveLength(1);
    expect((await tasks.outcome(task.id, saved)).revision).toBe(task.revision);
    await expect(tasks.resume(task.id, task.revision, saved.observation!)).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  });
  it('does not reset duration or attempt limits on resume', async () => {
    const task = await ready(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + task.limits.taskTimeoutMs + 1000);
    await expect(tasks.resume(task.id, task.revision, observation())).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
  });
  it('cancellation prevents fresh state from converting an unknown dispatch into completion', async () => {
    let task = await prepared('type', true); const proof = report(task, 'state_verified'); task = await tasks.stop(task.id);
    await expect(tasks.reconcile(task.id, task.revision, proof)).rejects.toMatchObject({ code: 'INVALID_RECONCILIATION' });
    await expect(tasks.resume(task.id, task.revision, observation())).rejects.toMatchObject({ code: 'NOT_READY' });
  });
  it('reserves interrupted planning anew and rejects older or cancelled inference responses', async () => {
    const replies: Array<(plan: ReturnType<typeof makePlan>) => void> = [];
    tasks = new TaskService(store, { generate: () => new Promise((resolve) => replies.push(resolve)) });
    await tasks.create('resume-task', { originalRequest: makePlan().goal, observation: observation() });
    await tasks.initialize(); let task = await tasks.get('resume-task'); const previousId = task.planningRequestId;
    await expect(tasks.resume(task.id, task.revision, { ...observation(), url: 'https://different.example' })).rejects.toMatchObject({ code: 'STALE_PLAN' });
    task = await tasks.resume(task.id, task.revision, observation()); expect(task.modelCallCount).toBe(2); expect(task.planningRequestId).not.toBe(previousId);
    const old = makePlan(); old.steps[0]!.description = 'Old interrupted response'; replies[0]!(old);
    await new Promise((done) => setTimeout(done, 20)); expect((await tasks.get(task.id)).plan).toBeNull();
    await tasks.stop(task.id); replies[1]!(makePlan()); await new Promise((done) => setTimeout(done, 20));
    expect((await tasks.get(task.id)).status).toBe('cancelled'); expect((await tasks.get(task.id)).plan).toBeNull();
  });
});
