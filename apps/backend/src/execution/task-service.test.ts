import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_URL, type FixtureActionResult, type TaskState } from '@clickflow/shared';
import { makeObservation, makePlan } from '../../../../tests/fixtures.js';
import { AtomicFileTaskStore } from '../state/atomic-file-task-store.js';
import { createApp } from '../app.js';
import { TaskService } from './task-service.js';
import { loadAccessToken } from './access-token.js';

let directory: string;
let store: AtomicFileTaskStore;
let tasks: TaskService;
const context = () => ({ ...makeObservation(), capturedAt: new Date().toISOString(), url: FIXTURE_URL });
const input = () => ({ originalRequest: makePlan().goal, observation: context() });
async function ready(id = 'task-1') {
  await tasks.create(id, input());
  await vi.waitFor(async () => expect((await tasks.get(id)).status).toBe('ready'));
  return tasks.get(id);
}
async function prepare() {
  let task = await ready();
  task = await tasks.start(task.id, task.revision, context());
  task = await tasks.authorize(task.id, task.revision, 'action-1');
  return task.pendingAction?.authorization.requiresConfirmation ? task : tasks.claim(task.id, task.pendingAction!.authorization.actionId, task.pendingAction!.authorization.leaseId);
}
function result(task: TaskState, passed = true): FixtureActionResult {
  const pending = task.pendingAction!;
  const observation = { ...context(), id: 'result-observation' };
  return { actionId: pending.authorization.actionId, actionType: 'click', dispatchStatus: 'dispatched', recordedAt: new Date().toISOString(), observation, error: null, extraction: null,
    verification: { status: passed ? 'passed' : 'failed', condition: pending.verification, checkedAt: new Date().toISOString(), explanation: 'Fixture predicate checked',
      evidence: passed ? [{ id: 'evidence-1', observationId: observation.id, capturedAt: observation.capturedAt, sourceUrl: observation.url, kind: 'dom', summary: 'Focus confirmed' }] : [] } };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clickflow-phase4-'));
  store = new AtomicFileTaskStore(directory); await store.initialize();
  tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function recoveryPatch(task: TaskState) {
  return { basePlanVersion: task.plan!.version, modifiedSteps: [{ ...task.plan!.steps[0]!, action: { type: 'observe' as const, timeoutMs: 1000 }, status: 'pending' as const }], insertedSteps: [], stepUpdates: [], evidenceIds: [], replanRequired: true, completionAssessmentRequested: false, explanation: 'Update only the failed action while retaining its attempt lineage.' };
}
describe('exact-action review checkpoint', () => {
  async function highRisk() {
    const plan = makePlan(); plan.steps[0]!.risk = 'high';
    tasks = new TaskService(store, { generate: async () => plan });
    return prepare();
  }
  function challenge(task: TaskState) {
    return { id: 'review-1', actionId: task.pendingAction!.authorization.actionId, observationId: task.currentContext!.id,
      documentId: task.currentContext!.documentId, origin: new URL(task.currentContext!.url).origin, fingerprint: 'a'.repeat(64),
      summary: 'Review the exact action', reasons: ['Consequential operation'], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  }
  it('requires recorded approval before accepting a high-risk dispatch', async () => {
    let task = await highRisk(); expect(task.pendingAction?.authorization.requiresConfirmation).toBe(true);
    await expect(tasks.outcome(task.id, result(task))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const review = challenge(task); task = await tasks.review(task.id, task.revision, review, false);
    expect(task.status).toBe('awaiting_confirmation');
    await expect(tasks.outcome(task.id, result(task))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    task = await tasks.review(task.id, task.revision, review, true);
    task = await tasks.claim(task.id, task.pendingAction!.authorization.actionId, task.pendingAction!.authorization.leaseId);
    task = await tasks.outcome(task.id, result(task)); expect(task.plan!.steps[0]!.status).toBe('completed');
  });
  it('invalidates changed fingerprints, expired approvals, revisions and cancelled tasks', async () => {
    let task = await highRisk(); const review = challenge(task); task = await tasks.review(task.id, task.revision, review, false);
    await expect(tasks.review(task.id, task.revision, { ...review, fingerprint: 'b'.repeat(64) }, true)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    await expect(tasks.review(task.id, task.revision, { ...review, expiresAt: '2020-01-01T00:00:00Z' }, true)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    await expect(tasks.review(task.id, task.revision - 1, review, true)).rejects.toMatchObject({ code: 'STALE_TASK' });
    task = await tasks.stop(task.id); await expect(tasks.review(task.id, task.revision, review, true)).rejects.toMatchObject({ code: 'STALE_TASK' });
  });
});
describe('bounded recovery orchestration', () => {
  it('a response from an interrupted recovery cannot replace a newer request on the same plan version', async () => {
    const replies: Array<(patch: ReturnType<typeof recoveryPatch>) => void> = [];
    tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update: () => new Promise((resolve) => { replies.push(resolve); }) });
    let task = await prepare(); task = await tasks.outcome(task.id, result(task, false));
    const old = await tasks.recover(task.id, task.revision, 'old-recovery', { observation: context() });
    await tasks.initialize(); task = await tasks.get(task.id);
    const latest = await tasks.recover(task.id, task.revision, 'new-recovery', { observation: context() });
    replies[0]!(recoveryPatch(old));
    await new Promise((done) => setTimeout(done, 30));
    expect((await tasks.get(task.id)).recoveryHistory).toHaveLength(0);
    replies[1]!({ ...recoveryPatch(latest), explanation: 'Current request only.' });
    await vi.waitFor(async () => expect((await tasks.get(task.id)).status).toBe('ready'));
    expect((await tasks.get(task.id)).recoveryHistory[0]?.patch.explanation).toBe('Current request only.');
    expect((await tasks.get(task.id)).recoveryAttemptCount).toBe(2);
  });
  it.each(['models', 'recoveries', 'actions', 'duration'])('enforces the total %s budget before requesting a model', async (kind) => {
    const update = vi.fn(); tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update });
    let task = await prepare(); task = await tasks.outcome(task.id, result(task, false));
    if (kind === 'models') task.limits.maxModelCalls = task.modelCallCount;
    if (kind === 'recoveries') task.limits.maxRecoveries = 0;
    if (kind === 'actions') task.limits.maxActions = 1;
    task = await store.save({ ...task, revision: task.revision + 1 }, task.revision);
    if (kind === 'duration') vi.useFakeTimers({ toFake: ['Date'] });
    try {
      if (kind === 'duration') vi.setSystemTime(Date.now() + task.limits.taskTimeoutMs + 1000);
      await expect(tasks.recover(task.id, task.revision, 'budget-recovery', { observation: context() })).rejects.toMatchObject({ code: 'LIMIT_REACHED' }); expect(update).not.toHaveBeenCalled();
    } finally { if (kind === 'duration') vi.useRealTimers(); }
  });
  it('applies an idempotent recovery request and retains attempt budgets across retry', async () => {
    const update = vi.fn(async (task: TaskState) => recoveryPatch(task));
    tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update });
    let task = await prepare(); task = await tasks.outcome(task.id, result(task, false));
    const reserved = await tasks.recover(task.id, task.revision, 'recovery-1', { observation: context() });
    expect(reserved.status).toBe('recovering');
    await vi.waitFor(async () => expect((await tasks.get(task.id)).status).toBe('ready'));
    task = await tasks.get(task.id);
    expect(task.recoveryHistory).toHaveLength(1); expect(task.retryCounts['step-1']).toBe(1);
    expect(task.modelCallCount).toBe(2); expect(task.recoveryAttemptCount).toBe(1);
    await tasks.recover(task.id, 0, 'recovery-1', { observation: context() }); expect(update).toHaveBeenCalledTimes(1);
    task = await tasks.start(task.id, task.revision, context()); task = await tasks.authorize(task.id, task.revision, 'action-2');
    task = await tasks.claim(task.id, task.pendingAction!.authorization.actionId, task.pendingAction!.authorization.leaseId);
    const failed = { ...result(task, false), actionType: 'observe' as const };
    task = await tasks.outcome(task.id, failed);
    await expect(tasks.recover(task.id, task.revision, 'recovery-2', { observation: context() })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('rejects pending/uncertain dispatches before calling recovery', async () => {
    const update = vi.fn(); tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update });
    let task = await prepare();
    await expect(tasks.recover(task.id, task.revision, 'pending-recovery', { observation: context() })).rejects.toMatchObject({ code: 'NOT_READY' });
    const uncertain = result(task, false); uncertain.dispatchStatus = 'uncertain';
    task = await tasks.outcome(task.id, uncertain);
    await expect(tasks.recover(task.id, task.revision, 'uncertain-recovery', { observation: context() })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' }); expect(update).not.toHaveBeenCalled();
  });
  it('Stop rejects a late recovery response without modifying the plan', async () => {
    let resolve!: (patch: ReturnType<typeof recoveryPatch>) => void;
    tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update: () => new Promise((done) => { resolve = done; }) });
    let task = await prepare(); task = await tasks.outcome(task.id, result(task, false));
    const original = structuredClone(task.plan);
    const reserved = await tasks.recover(task.id, task.revision, 'late-recovery', { observation: context() });
    await tasks.stop(task.id); resolve(recoveryPatch(reserved));
    await new Promise((done) => setTimeout(done, 30));
    expect((await tasks.get(task.id)).plan).toEqual(original); expect((await tasks.get(task.id)).status).toBe('cancelled');
  });
  it('failed recovery consumes its budget and preserves the old plan', async () => {
    tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(makePlan()) }, { update: vi.fn().mockRejectedValue(new Error('private model error')) });
    let task = await prepare(); task = await tasks.outcome(task.id, result(task, false));
    await tasks.recover(task.id, task.revision, 'bad-recovery', { observation: context() });
    await vi.waitFor(async () => expect((await tasks.get(task.id)).status).toBe('paused'));
    const current = await tasks.get(task.id); expect(current.recoveryAttemptCount).toBe(1); expect(current.modelCallCount).toBe(2); expect(current.plan).toEqual(task.plan);
    expect(JSON.stringify(current.errors)).not.toContain('private model error');
  });
});

describe('persisted one-action orchestration', () => {
  it('creates one whole pending plan before Start with stable idempotent creation', async () => {
    const task = await ready(); const repeat = await tasks.create(task.id, input());
    expect(repeat).toEqual(task); expect(task.plan?.steps).toHaveLength(2);
    expect(task.actionHistory).toHaveLength(0); expect(task.plan?.steps.every((step) => step.status === 'pending')).toBe(true);
  });
  it('persists authorization before dispatch and blocks a second action', async () => {
    const task = await prepare();
    expect((await store.get(task.id))?.pendingAction).toEqual(task.pendingAction);
    expect(task.pendingAction?.authorization).toMatchObject({ taskId: task.id, stepId: 'step-1', planVersion: task.plan?.version, observationId: task.currentContext?.id, attempt: 1 });
    await expect(tasks.authorize(task.id, task.revision, 'action-2')).rejects.toMatchObject({ code: 'NOT_READY' });
    expect((await tasks.authorize(task.id, task.revision - 1, 'action-1')).pendingAction).toEqual(task.pendingAction);
  });
  it('updates the existing plan deterministically only with verification evidence', async () => {
    const task = await prepare(); const outcome = result(task);
    const updated = await tasks.outcome(task.id, outcome);
    expect(updated.status).toBe('paused'); expect(updated.pendingAction).toBeNull();
    expect(updated.plan?.version).toBe(task.plan!.version + 1);
    expect(updated.plan?.steps[0]).toMatchObject({ id: 'step-1', status: 'completed', evidenceIds: ['evidence-1'] });
    expect(updated.plan?.steps[1]).toEqual(task.plan?.steps[1]);
    expect(await tasks.outcome(task.id, outcome)).toEqual(updated);
    expect(updated.status).not.toBe('completed');
  });
  it('a successful browser dispatch without passing verification is a failed step', async () => {
    const task = await prepare(); const updated = await tasks.outcome(task.id, result(task, false));
    expect(updated.plan?.steps[0]?.status).toBe('failed'); expect(updated.actionHistory[0]?.dispatchStatus).toBe('dispatched');
  });
  it('rejects forged or unrelated verification evidence and predicates', async () => {
    const task = await prepare(); const outcome = result(task); outcome.verification!.evidence[0]!.observationId = 'other-page';
    await expect(tasks.outcome(task.id, outcome)).rejects.toMatchObject({ code: 'OUTCOME_MISMATCH' });
    const changed = result(task); changed.verification!.condition = { type: 'text_present', text: 'unrelated' };
    await expect(tasks.outcome(task.id, changed)).rejects.toMatchObject({ code: 'OUTCOME_MISMATCH' });
    expect((await tasks.get(task.id)).pendingAction).not.toBeNull();
  });
  it('requires fresh identity-bound observations and current revisions', async () => {
    const task = await ready();
    await expect(tasks.start(task.id, task.revision - 1, context())).rejects.toMatchObject({ code: 'STALE_TASK' });
    await expect(tasks.start(task.id, task.revision, { ...context(), documentId: 'changed' })).rejects.toMatchObject({ code: 'DOCUMENT_CHANGED' });
    await expect(tasks.start(task.id, task.revision, { ...context(), capturedAt: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'STALE_OBSERVATION' });
  });

  it('rejects extraction records unrelated to the prepared action', async () => {
    const task = await prepare(); const outcome = result(task);
    outcome.extraction = { outputKey: 'product', schemaId: 'text-v1', text: 'Unrelated record', sourceUrl: outcome.observation!.url, capturedAt: outcome.observation!.capturedAt, observationId: outcome.observation!.id };
    await expect(tasks.outcome(task.id, outcome)).rejects.toMatchObject({ code: 'OUTCOME_MISMATCH' });
    expect((await tasks.get(task.id)).pendingAction).not.toBeNull();
  });

  it('requires navigation to verify its exact destination; website consent is checked by the worker', async () => {
    const plan = makePlan(); plan.steps[0]!.action = { type: 'navigate', url: 'https://example.com', timeoutMs: 1000 };
    tasks = new TaskService(store, { generate: vi.fn().mockResolvedValue(plan) });
    let task = await ready(); task = await tasks.start(task.id, task.revision, context());
    await expect(tasks.authorize(task.id, task.revision, 'unsafe-navigation')).rejects.toMatchObject({ code: 'UNSUPPORTED_STEP' });
    expect((await tasks.get(task.id)).pendingAction).toBeNull();
  });
  it('Stop prevents future authorization and late success cannot mark completion', async () => {
    const task = await prepare(); const stopped = await tasks.stop(task.id);
    await expect(tasks.authorize(task.id, stopped.revision, 'action-2')).rejects.toMatchObject({ code: 'NOT_READY' });
    const updated = await tasks.outcome(task.id, result(task));
    expect(updated.status).toBe('cancelled'); expect(updated.plan?.steps[0]?.status).toBe('failed');
  });
  it('Stop during model planning ignores the late plan', async () => {
    let resolve!: (value: ReturnType<typeof makePlan>) => void;
    const pending = new Promise<ReturnType<typeof makePlan>>((done) => { resolve = done; });
    tasks = new TaskService(store, { generate: () => pending });
    const task = await tasks.create('task-1', input()); await tasks.stop(task.id); resolve(makePlan());
    await new Promise((done) => setTimeout(done, 30));
    expect((await tasks.get(task.id)).plan).toBeNull(); expect((await tasks.get(task.id)).status).toBe('cancelled');
  });
  it('restarts with an unresolved authorization paused and never reauthorizes it', async () => {
    const task = await prepare(); const restarted = new TaskService(store, { generate: vi.fn() });
    await restarted.initialize(); const paused = await restarted.get(task.id);
    expect(paused.status).toBe('paused'); expect(paused.pendingAction).toEqual(task.pendingAction);
    await expect(restarted.start(task.id, paused.revision, context())).rejects.toMatchObject({ code: 'NOT_READY' });
  });
  it('one active task and id reuse checks prevent duplicate planning', async () => {
    await ready(); await expect(tasks.create('task-2', input())).rejects.toMatchObject({ code: 'TASK_ACTIVE' });
    await expect(tasks.create('task-1', { ...input(), originalRequest: 'Different goal' })).rejects.toMatchObject({ code: 'ID_REUSED' });
  });
  it('discovers the real active task independently of a missing selected ID without changing it', async () => {
    expect(await tasks.getActive()).toBeNull();
    const current = await ready('older-paused-task');
    await expect(tasks.create('never-created', input())).rejects.toMatchObject({ code: 'TASK_ACTIVE' });
    await expect(tasks.get('never-created')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await tasks.getActive()).toEqual(current);
    await tasks.stop(current.id); expect(await tasks.getActive()).toBeNull();
  });
  it('authorizes finish as an assessment request without claiming overall completion', async () => {
    let task = await prepare(); task = await tasks.outcome(task.id, result(task));
    task = await tasks.start(task.id, task.revision, context());
    const prepared = await tasks.authorize(task.id, task.revision, 'finish-1');
    expect(prepared.pendingAction?.authorization.action.type).toBe('finish');
    expect(prepared.result).toBeNull();
  });
  it('stores model failures with safe actionable errors', async () => {
    tasks = new TaskService(store, { generate: vi.fn().mockRejectedValue(new Error('private details')) });
    await tasks.create('failed-task', input()); await vi.waitFor(async () => expect((await tasks.get('failed-task')).status).toBe('failed'));
    expect(JSON.stringify(await tasks.get('failed-task'))).not.toContain('private details');
  });
  it('connection token persists with private file permissions', async () => {
    const token = await loadAccessToken(directory);
    expect(await loadAccessToken(directory)).toBe(token); expect(token).toHaveLength(64);
    expect((await stat(join(directory, 'extension-token'))).mode & 0o777).toBe(0o600);
  });
});

describe('authenticated task HTTP protocol', () => {
  let server: Server; let url: string;
  const token = 'a'.repeat(64);
  beforeEach(async () => {
    server = createApp({ MODEL_NAME: 'mock' }, { tasks, accessToken: token }).listen(0, '127.0.0.1');
    await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { server.closeIdleConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  it('requires authentication to discover the active checkpoint and returns null after Stop', async () => {
    expect((await fetch(`${url}/api/tasks`)).status).toBe(401);
    expect((await fetch(`${url}/api/tasks`, { headers: { ...headers, Origin: 'http://127.0.0.1:5173' } })).status).toBe(401);
    expect(await (await fetch(`${url}/api/tasks`, { headers })).json()).toEqual({ task: null });
    const current = await ready();
    expect(await (await fetch(`${url}/api/tasks`, { headers })).json()).toEqual({ task: current });
    expect((await tasks.get(current.id)).revision).toBe(current.revision);
    await tasks.stop(current.id);
    expect(await (await fetch(`${url}/api/tasks`, { headers })).json()).toEqual({ task: null });
  });
  it('rejects missing tokens, malformed tokens, and preview website callers', async () => {
    expect((await fetch(`${url}/api/tasks/task-1`)).status).toBe(401);
    expect((await fetch(`${url}/api/tasks/task-1`, { headers: { Authorization: 'Bearer ' + 'é'.repeat(64) } })).status).toBe(401);
    expect((await fetch(`${url}/api/tasks/task-1`, { headers: { ...headers, Origin: 'http://127.0.0.1:5173' } })).status).toBe(401);
  });
  it('creates, reads and polls versioned event snapshots with real typed endpoints', async () => {
    const created = await fetch(`${url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ taskId: 'api-task', input: input() }) });
    expect(created.status).toBe(202);
    await vi.waitFor(async () => expect((await tasks.get('api-task')).status).toBe('ready'));
    const event = await (await fetch(`${url}/api/tasks/api-task/events`, { headers })).json();
    expect(event.type).toBe('task_snapshot');
    expect((await fetch(`${url}/api/tasks/api-task/events?afterRevision=${event.taskRevision}`, { headers })).status).toBe(204);
    expect((await fetch(`${url}/api/tasks/api-task/events?afterEventId=${event.id}`, { headers })).status).toBe(204);
    expect((await fetch(`${url}/api/tasks/api-task/events?afterEventId=api-task_other_1`, { headers })).status).toBe(400);
    const started = await fetch(`${url}/api/tasks/api-task/start`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: event.taskRevision, observation: context() }) });
    expect(started.status).toBe(200);
    const reconnected = await (await fetch(`${url}/api/tasks/api-task/events?afterEventId=${event.id}`, { headers })).json();
    expect(reconnected.taskRevision).toBeGreaterThan(event.taskRevision); expect(reconnected.id).toBe(`api-task_${reconnected.taskRevision}`);
  });
  it('rejects invalid JSON and schema bodies without exposing contents', async () => {
    const response = await fetch(`${url}/api/tasks`, { method: 'POST', headers, body: '{private garbage' });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private garbage');
    expect((await fetch(`${url}/api/tasks`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  });
});
