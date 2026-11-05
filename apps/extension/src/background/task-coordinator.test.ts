import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSessionSchema, taskExecutionCommandSchema, taskStateSchema, type BrowserToolResponse } from '@clickflow/shared';
import { makeObservation, makePlan, makeTask } from '../../../../tests/fixtures.js';
import { TaskCoordinator } from './task-coordinator.js';
import { JOURNAL_KEY } from './journal.js';
import { backendTask } from './task-transport.js';

vi.mock('./task-transport.js', async (load) => ({ ...await load<typeof import('./task-transport.js')>(), backendTask: vi.fn() }));
beforeEach(() => { vi.mocked(backendTask).mockReset(); });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, data[name]])),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); }) };
  vi.stubGlobal('chrome', { storage: { local: storage } });
  const observation = { ...makeObservation(), capturedAt: new Date().toISOString() };
  const session = fixtureSessionSchema.parse({ id: 'session-1', revision: 0, tabId: 1, windowId: 1, documentId: observation.documentId,
    stopped: false, runningActionId: null, attemptedActionIds: [], observation, lastResult: null, lastError: null });
  const plan = makePlan(); plan.version = 2; plan.currentStepId = 'step-1'; plan.steps[0]!.status = 'in_progress';
  const command = taskExecutionCommandSchema.parse({ kind: 'execute_task_action', sessionId: session.id, authorization: { taskId: makeTask().id,
    planVersion: 2, stepId: 'step-1', actionId: 'action-1', attempt: 1, observationId: observation.id, leaseId: 'lease-1', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    action: plan.steps[0]!.action, protocolVersion: 2 }, verification: plan.steps[0]!.verification });
  let task = taskStateSchema.parse({ ...makeTask(), revision: 1, status: 'executing', plan, initialContext: observation, currentContext: observation,
    pendingAction: { authorization: command.authorization, verification: command.verification } });
  vi.mocked(backendTask).mockImplementation(async (path) => {
    if (path.endsWith('/stop')) task = { ...task, cancellationRequested: true, status: 'cancelled' };
    if (path.endsWith('/claim')) task = { ...task, dispatchClaims: [{ actionId: 'action-1', leaseId: 'lease-1', claimedAt: new Date().toISOString() }] };
    return task;
  });
  const tool = vi.fn(async (input: unknown): Promise<BrowserToolResponse> => { void input; return { ok: true, session }; });
  const browser = { tool, interrupt: vi.fn(async () => undefined), cachedResult: vi.fn(async () => ({ kind: 'cached_result', result: null })),
    checkState: vi.fn(async () => ({ kind: 'checked_state', observation, verification: null })) };
  const coordinator = new TaskCoordinator(browser);
  return { coordinator, browser, command, storage, data, session, getTask: () => task };
}
describe('dispatch/reconciliation exclusion and failure boundaries', () => {
  it('a storage failure before the dispatch checkpoint prevents both claim and browser action', async () => {
    const { coordinator, command, storage, browser } = fixture();
    const save = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async (value) => {
      const journal = value[JOURNAL_KEY] as { active?: { phase: string } } | undefined;
      if (journal?.active?.phase === 'dispatching') throw new Error('quota');
      await save(value);
    });
    const response = await coordinator.execute(command);
    expect(response.ok).toBe(false); expect(vi.mocked(backendTask).mock.calls.some(([path]) => path.endsWith('/claim'))).toBe(false);
    expect(browser.tool.mock.calls.some(([input]) => (input as { kind: string }).kind === 'execute_fixture')).toBe(false);
    expect((await coordinator.journal.read()).active!.phase).toBe('prepared');
  });
  it('an uncertain journal cannot be prepared or replayed by a repeated execute message', async () => {
    const { coordinator, command, session, browser } = fixture();
    await coordinator.journal.prepare(command, { tabId: 1, windowId: 1, documentId: session.documentId });
    await coordinator.journal.transition('action-1', (record) => ({ ...record, phase: 'uncertain' }));
    expect((await coordinator.execute(command)).ok).toBe(false); expect(browser.tool).not.toHaveBeenCalled(); expect(backendTask).not.toHaveBeenCalled();
  });
  it('resume holds an exclusion lock so a concurrent execute cannot turn no-dispatch proof into a lie', async () => {
    const { coordinator, browser, command, session } = fixture();
    await coordinator.journal.prepare(command, { tabId: 1, windowId: 1, documentId: session.documentId });
    let finish: ((response: BrowserToolResponse) => void) | undefined;
    browser.tool.mockImplementation(async (input) => (input as { kind: string }).kind === 'bind_fixture' ? new Promise<BrowserToolResponse>((resolve) => { finish = resolve; }) : { ok: true, session });
    const resuming = coordinator.control({ kind: 'sync_task', taskId: command.authorization.taskId, resume: true, allowTabRelink: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await coordinator.execute(command)).ok).toBe(false);
    finish!({ ok: false, session: null, error: { code: 'DOCUMENT_CHANGED', message: 'Test interrupted the binding.' } });
    await resuming;
    expect(browser.tool.mock.calls.some(([input]) => (input as { kind: string }).kind === 'execute_fixture')).toBe(false);
  });
  it('Stop attempts backend cancellation even if storage fails and rejects a late command immediately', async () => {
    const { coordinator, command, storage, browser, getTask } = fixture();
    storage.set.mockRejectedValue(new Error('quota'));
    await coordinator.control({ kind: 'stop_task', taskId: command.authorization.taskId });
    expect(browser.interrupt).toHaveBeenCalled(); expect(getTask().cancellationRequested).toBe(true);
    expect((await coordinator.execute(command)).ok).toBe(false); expect(browser.tool).not.toHaveBeenCalled();
  });
});
