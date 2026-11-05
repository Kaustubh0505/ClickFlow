import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type CompletionProposal, type TaskState, type GoalCheck, type Observation } from '@clickflow/shared';
import { makeObservation, makePlan } from '../../../../tests/fixtures.js';
import { AtomicFileTaskStore } from '../state/atomic-file-task-store.js';
import { TaskService } from './task-service.js';
import { deterministicAssessment, evidenceCatalog, validateCompletion } from './completion-checker.js';
import { ModelError } from '../agent/errors.js';

let directory: string; let store: AtomicFileTaskStore; let service: TaskService;
let plan: ReturnType<typeof makePlan>;
const observe = () => ({ ...makeObservation(), capturedAt: new Date().toISOString() });
const proposal = (task: TaskState): CompletionProposal => ({ status: 'completed', criteria: task.plan!.goalCriteria.map((criterion) => ({ criterionId: criterion.id, status: 'met', evidenceIds: ['proof-1'], citations: [{ evidenceId: 'proof-1', quote: 'Search input is focused' }] })) });
const assess = vi.fn(async (task: TaskState) => proposal(task));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clickflow-completion-')); store = new AtomicFileTaskStore(directory); await store.initialize();
  plan = makePlan(); assess.mockReset(); assess.mockImplementation(async (task) => proposal(task));
  service = new TaskService(store, { generate: async () => structuredClone(plan) }, undefined, { assess });
});
afterEach(async () => { vi.useRealTimers(); await rm(directory, { force: true, recursive: true }); });
async function ready() {
  await service.create('task-1', { originalRequest: plan.goal, observation: observe() });
  await vi.waitFor(async () => expect((await service.get('task-1')).status).toBe('ready'));
  return service.get('task-1');
}
async function verified() {
  let task = await ready(); task = await service.start(task.id, task.revision, observe());
  task = await service.authorize(task.id, task.revision, 'action-1'); task = await service.claim(task.id, 'action-1', task.pendingAction!.authorization.leaseId);
  const observation = { ...observe(), id: 'outcome-observation' };
  return service.outcome(task.id, { actionId: 'action-1', actionType: 'click', dispatchStatus: 'dispatched', recordedAt: new Date().toISOString(), extraction: null, error: null, observation,
    verification: { condition: task.pendingAction!.verification, status: 'passed', checkedAt: observation.capturedAt, explanation: 'Observed real fixture predicate',
      evidence: [{ id: 'proof-1', observationId: observation.id, sourceUrl: observation.url, capturedAt: observation.capturedAt, kind: 'dom', summary: 'Search input is focused' }] } });
}
async function settled() { await vi.waitFor(async () => expect((await service.get('task-1')).status).not.toBe('waiting_for_model')); return service.get('task-1'); }
function freshCheck(observation: Observation, status: 'passed' | 'failed' = 'passed'): GoalCheck {
  return { criterionId: 'criterion-1', verification: { condition: plan.goalCriteria[0]!.verification!, status, checkedAt: observation.capturedAt, explanation: 'Fresh read-only check',
    evidence: status === 'passed' ? [{ id: 'fresh-proof', observationId: observation.id, sourceUrl: observation.url, capturedAt: observation.capturedAt, kind: 'dom', summary: 'Original predicate matches fresh page' }] : [] } };
}

it('assesses all criteria from recorded evidence and completes the stable finish step', async () => {
  const task = await verified(); const ids = task.plan!.steps.map((step) => step.id);
  await service.assess(task.id, task.revision, 'assessment-1', { observation: observe() });
  const result = await settled(); expect(result.status).toBe('completed'); expect(result.plan!.steps.map((step) => step.id)).toEqual(ids);
  expect(result.plan!.steps.every((step) => step.status === 'completed')).toBe(true); expect(result.result!.evidence[0]!.id).toBe('proof-1'); expect(result.modelCallCount).toBe(2);
  expect(result.completionHistory).toHaveLength(1); expect(result.actionHistory).toHaveLength(1);
  const reloaded = new AtomicFileTaskStore(directory); await reloaded.initialize(); expect(await reloaded.get(task.id)).toEqual(result);
  expect(await service.assess(task.id, 0, 'assessment-1', { observation: observe() })).toEqual(result); expect(assess).toHaveBeenCalledTimes(1);
});
it.each(['fake-id', 'fake-quote', 'missing-citation', 'missing-criterion', 'duplicate-criterion', 'changed-criterion', 'unresolved-work', 'wrong-status'])('rejects unsupported completion: %s', async (kind) => {
  const task = await verified(); const output = proposal(task);
  if (kind === 'fake-id') output.criteria[0]!.evidenceIds = ['invented'];
  if (kind === 'fake-quote') output.criteria[0]!.citations[0]!.quote = 'Three laptops were purchased';
  if (kind === 'missing-citation') output.criteria[0]!.citations = [];
  if (kind === 'missing-criterion') output.criteria = [];
  if (kind === 'duplicate-criterion') output.criteria.push(output.criteria[0]!);
  if (kind === 'changed-criterion') output.criteria[0]!.criterionId = 'changed-goal';
  if (kind === 'unresolved-work') task.plan!.steps[0]!.status = 'pending';
  if (kind === 'wrong-status') output.status = 'blocked';
  expect(() => validateCompletion(task, output)).toThrow();
});
it('preserves source identity from earlier pages instead of substituting the final page', async () => {
  const task = await verified(); const before = task.actionHistory[0]!.verification!.evidence[0]!;
  task.currentContext = { ...observe(), url: 'https://example.com/another-page', documentId: 'another-document' };
  const result = validateCompletion(task, proposal(task)); expect(result.evidence[0]).toEqual(before); expect(result.evidence[0]!.sourceUrl).not.toBe(task.currentContext.url);
});
it('distinguishes partial from missing evidence without falsely completing finish', async () => {
  plan.goalCriteria.push({ id: 'criterion-2', description: 'Three products were compared' });
  const task = await verified(); const output = proposal(task); output.status = 'partial'; output.criteria[1] = { criterionId: 'criterion-2', status: 'unknown', evidenceIds: [], citations: [] };
  assess.mockResolvedValue(output); await service.assess(task.id, task.revision, 'partial-1', { observation: observe() });
  const result = await settled(); expect(result.status).toBe('paused'); expect(result.result?.status).toBe('partial'); expect(result.plan!.steps.at(-1)!.status).toBe('blocked');
});
it('returns blocked without inference when no verified evidence exists', async () => {
  const task = await ready(); await service.assess(task.id, task.revision, 'empty-1', { observation: observe() });
  const result = await settled(); expect(result.result?.status).toBe('blocked'); expect(result.result?.evidence).toEqual([]); expect(result.modelCallCount).toBe(1); expect(assess).not.toHaveBeenCalled();
});
it('never uses a failed or merely dispatched action as evidence', async () => {
  const task = await verified(); task.actionHistory[0]!.verification!.status = 'failed';
  expect(evidenceCatalog(task)).toEqual([]); expect(() => validateCompletion(task, proposal(task))).toThrow();
});
it('excludes an unreconciled uncertain effect even if a stored predicate says passed', async () => {
  const task = await verified(); task.actionHistory[0]!.dispatchStatus = 'uncertain';
  expect(evidenceCatalog(task)).toEqual([]);
  const updated = await store.save({ ...task, revision: task.revision + 1 }, task.revision);
  await expect(service.assess(task.id, updated.revision, 'uncertain-1', { observation: observe() })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
});
it('rejects a result that arrives after the original duration budget even if cancellation has not fired', async () => {
  const task = await verified();
  assess.mockImplementation(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + task.limits.taskTimeoutMs + 1000); return proposal(task); });
  await service.assess(task.id, task.revision, 'expired-1', { observation: observe() });
  const result = await settled(); expect(result.result).toBeNull(); expect(result.errors.at(-1)?.code).toBe('LIMIT_REACHED');
});
it('requires fresh read-only checks for current-state typed criteria and uses no model', async () => {
  plan.goalCriteria[0]!.verification = plan.steps[0]!.verification;
  const task = await verified();
  const stale = deterministicAssessment(task, evidenceCatalog(task))!; expect(stale.status).toBe('blocked');
  expect(() => validateCompletion(task, proposal(task))).toThrow('freshly verified');
  const observation = observe(); await service.assess(task.id, task.revision, 'typed-1', { observation, goalChecks: [freshCheck(observation)] });
  const result = await settled(); expect(result.status).toBe('completed'); expect(result.result!.evidence.map((entry) => entry.id)).toEqual(['fresh-proof']); expect(result.modelCallCount).toBe(1); expect(assess).not.toHaveBeenCalled();
});
it('a changed final predicate cannot be satisfied by matching historical evidence', async () => {
  plan.goalCriteria[0]!.verification = plan.steps[0]!.verification; const task = await verified(); const observation = observe();
  await service.assess(task.id, task.revision, 'changed-1', { observation, goalChecks: [freshCheck(observation, 'failed')] });
  expect((await settled()).result?.status).toBe('blocked'); expect(assess).not.toHaveBeenCalled();
});
it('rejects changed criterion predicates and forged fresh source metadata before inference', async () => {
  plan.goalCriteria[0]!.verification = plan.steps[0]!.verification; const task = await verified(); const observation = observe(); const check = freshCheck(observation);
  check.verification.evidence[0]!.observationId = 'different-page';
  await expect(service.assess(task.id, task.revision, 'forged-1', { observation, goalChecks: [check] })).rejects.toThrow(); expect(assess).not.toHaveBeenCalled();
});
it('Stop ignores a late completion response and keeps prior verified work', async () => {
  let resolve!: (value: CompletionProposal) => void; assess.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const task = await verified(); await service.assess(task.id, task.revision, 'slow-1', { observation: observe() });
  await service.stop(task.id); resolve(proposal(task)); await new Promise((done) => setTimeout(done, 20));
  const result = await service.get(task.id); expect(result.status).toBe('cancelled'); expect(result.result).toBeNull(); expect(result.plan!.steps[0]!.status).toBe('completed');
});
it('restart rejects an older assessment response on the same plan version', async () => {
  const replies: Array<(value: CompletionProposal) => void> = []; assess.mockImplementation(() => new Promise((done) => { replies.push(done); }));
  const task = await verified(); await service.assess(task.id, task.revision, 'old-1', { observation: observe() });
  await service.initialize(); let current = await service.get(task.id); expect(current.resumeRequired).toBe(true);
  current = await service.resume(task.id, current.revision, observe()); await service.assess(task.id, current.revision, 'new-1', { observation: observe() });
  replies[0]!(proposal(task)); await new Promise((done) => setTimeout(done, 20)); expect((await service.get(task.id)).result).toBeNull();
  replies[1]!(proposal(task)); expect((await settled()).completionHistory[0]!.requestId).toBe('new-1');
});
it.each(['budget', 'stale-revision', 'stale-observation', 'pending', 'cancelled'])('rejects unsafe assessment admission: %s', async (kind) => {
  let task = await verified(); let revision = task.revision; const observation = observe();
  if (kind === 'budget') task = await store.save({ ...task, revision: task.revision + 1, limits: { ...task.limits, maxModelCalls: 1 } }, task.revision);
  if (kind === 'stale-revision') revision--;
  else revision = task.revision;
  if (kind === 'stale-observation') observation.capturedAt = '2020-01-01T00:00:00Z';
  if (kind === 'pending') { task = await service.start(task.id, task.revision, observe()); task = await service.authorize(task.id, task.revision, 'finish-action'); revision = task.revision; }
  if (kind === 'cancelled') { task = await service.stop(task.id); revision = task.revision; }
  await expect(service.assess(task.id, revision, 'unsafe-1', { observation })).rejects.toThrow(); expect(assess).not.toHaveBeenCalled();
});
it('records normalized API failures without a fabricated completion', async () => {
  const task = await verified(); assess.mockRejectedValue(new ModelError('RATE_LIMITED'));
  await service.assess(task.id, task.revision, 'error-1', { observation: observe() });
  const result = await settled(); expect(result.result).toBeNull(); expect(result.errors.at(-1)!.code).toBe('RATE_LIMITED'); expect(result.modelCallCount).toBe(2);
});
it('persists tightened limits and rejects attempts to raise them or change an idempotent request', async () => {
  const input = { originalRequest: plan.goal, observation: observe() };
  const task = await service.create('limited', input, { maxActions: 3, maxModelCalls: 2 });
  expect(task.limits.maxActions).toBe(3); expect(task.limits.maxModelCalls).toBe(2);
  await expect(service.create('limited', input, { maxActions: 4 })).rejects.toMatchObject({ code: 'ID_REUSED' });
  await expect(service.create('new', input, { maxActions: 51 })).rejects.toThrow();
});
