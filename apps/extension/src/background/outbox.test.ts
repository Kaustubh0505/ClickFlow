import { describe, expect, it, vi } from 'vitest';
import { taskExecutionCommandSchema, taskStateSchema, type TaskState } from '@clickflow/shared';
import { makePlan, makeTask } from '../../../../tests/fixtures.js';
import { ExecutionJournal } from './journal.js';
import { OutcomeOutbox } from './outbox.js';
import { TransportError } from './task-transport.js';

async function fixture() {
  const data: Record<string, unknown> = {};
  const journal = new ExecutionJournal({ get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, data[name]])),
    set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); } } as Pick<chrome.storage.StorageArea, 'get' | 'set'>);
  const task = makeTask();
  const command = taskExecutionCommandSchema.parse({ kind: 'execute_task_action', sessionId: 'session-1', authorization: { taskId: task.id, planVersion: 2, stepId: 'step-1', actionId: 'action-1', attempt: 1,
    observationId: 'observation-1', leaseId: 'lease-1', leaseExpiresAt: new Date().toISOString(), action: makePlan().steps[0]!.action }, verification: makePlan().steps[0]!.verification });
  await journal.prepare(command, { tabId: 1, windowId: 1, documentId: 'document-1' });
  const result = { actionId: 'action-1', actionType: 'click' as const, dispatchStatus: 'dispatched' as const, recordedAt: new Date().toISOString(), verification: null, observation: null, extraction: null, error: null };
  await journal.transition('action-1', (record) => ({ ...record, phase: 'outcome_ready', result }));
  const { actionId: _id, actionType: _type, observation: _observation, ...outcome } = result; void _id; void _type; void _observation;
  const acknowledged: TaskState = taskStateSchema.parse({ ...task, actionHistory: [{ ...outcome, authorization: command.authorization }] });
  return { journal, result, acknowledged };
}
describe('outcome and cancellation outbox', () => {
  it('retries only the identical recorded outcome after a lost response; duplicate delivery has one receipt', async () => {
    const { journal, result, acknowledged } = await fixture(); let calls = 0;
    const request = vi.fn(async (_path: string, body?: unknown) => { expect(body).toEqual({ result }); if (++calls === 1) throw new TransportError('BACKEND_OFFLINE', 'Disconnected', true); return acknowledged; });
    const outbox = new OutcomeOutbox(journal, request); await Promise.all([outbox.flush(), outbox.flush()]);
    expect(request).toHaveBeenCalledTimes(2); expect((await journal.read()).receipts).toHaveLength(1); expect((await journal.read()).active!.phase).toBe('acknowledged');
    await outbox.flush(); expect(request).toHaveBeenCalledTimes(2);
  });
  it('bounds retryable delivery attempts and retains the result for the next explicit reconnect', async () => {
    const { journal, acknowledged } = await fixture(); const request = vi.fn().mockRejectedValue(new TransportError('BACKEND_OFFLINE', 'Disconnected', true));
    await new OutcomeOutbox(journal, request).flush(); expect(request).toHaveBeenCalledTimes(3); expect((await journal.read()).active!.phase).toBe('outcome_ready');
    request.mockResolvedValue(acknowledged); await new OutcomeOutbox(journal, request).flush(); expect((await journal.read()).active!.phase).toBe('acknowledged');
  });
  it('does not retry non-retryable authentication errors or discard the checkpoint', async () => {
    const { journal } = await fixture(); const request = vi.fn().mockRejectedValue(new TransportError('UNAUTHORIZED', 'Pair again'));
    await new OutcomeOutbox(journal, request).flush(); expect(request).toHaveBeenCalledTimes(1); expect((await journal.read()).lastError!.code).toBe('UNAUTHORIZED'); expect((await journal.read()).active!.result).not.toBeNull();
  });
  it('delivers durable cancellation before the late outcome so it cannot revive the task', async () => {
    const { journal, acknowledged } = await fixture(); await journal.cancel(acknowledged.id);
    const calls: string[] = []; const request = vi.fn(async (path: string) => { calls.push(path); return { ...acknowledged, cancellationRequested: true, status: 'cancelled' as const }; });
    await new OutcomeOutbox(journal, request).flush(); expect(calls).toEqual([`/${acknowledged.id}/stop`, `/${acknowledged.id}/outcome`]);
    expect((await journal.read()).cancellations[0]!.acknowledged).toBe(true);
  });
  it('does not send an outcome ahead of an unacknowledged cancellation', async () => {
    const { journal, acknowledged } = await fixture(); await journal.cancel(acknowledged.id);
    const request = vi.fn().mockRejectedValue(new TransportError('BACKEND_OFFLINE', 'Disconnected', true)); await new OutcomeOutbox(journal, request).flush();
    expect(request.mock.calls.every((call) => call[0].endsWith('/stop'))).toBe(true); expect((await journal.read()).cancellations[0]!.acknowledged).toBe(false);
  });
  it('sanitizes unexpected failures rather than storing exception bodies in logs', async () => {
    const { journal } = await fixture(); await new OutcomeOutbox(journal, vi.fn().mockRejectedValue(new Error('private raw exception'))).flush();
    expect(JSON.stringify((await journal.read()).lastError)).not.toContain('private raw exception');
  });
  it('a cancellation issued before task creation does not block unrelated outcome delivery', async () => {
    const { journal, acknowledged } = await fixture(); await journal.cancel('not-created-yet');
    const request = vi.fn(async (path: string) => { if (path.includes('not-created-yet')) throw new TransportError('NOT_FOUND', 'Task not created yet'); return acknowledged; });
    await new OutcomeOutbox(journal, request).flush(); const state = await journal.read();
    expect(state.active!.phase).toBe('acknowledged'); expect(state.cancellations[0]!.acknowledged).toBe(false);
  });
  it('an already failed terminal task acknowledges Stop without leaving a permanent cancellation retry', async () => {
    const { journal, acknowledged } = await fixture(); await journal.cancel(acknowledged.id);
    const request = vi.fn(async () => ({ ...acknowledged, status: 'failed' as const })); await new OutcomeOutbox(journal, request).flush();
    expect((await journal.read()).cancellations[0]!.acknowledged).toBe(true); expect((await journal.read()).active!.phase).toBe('acknowledged');
  });
});
