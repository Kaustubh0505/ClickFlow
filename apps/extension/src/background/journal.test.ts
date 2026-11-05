import { describe, expect, it } from 'vitest';
import { taskExecutionCommandSchema } from '@clickflow/shared';
import { makeTask, makePlan, makeObservation } from '../../../../tests/fixtures.js';
import { CHECKPOINT_KEY, ExecutionJournal, JOURNAL_KEY } from './journal.js';

function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, data[name]])),
    set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); } } as Pick<chrome.storage.StorageArea, 'get' | 'set'>;
  const journal = new ExecutionJournal(storage);
  const command = taskExecutionCommandSchema.parse({ kind: 'execute_task_action', sessionId: 'session-1', authorization: { taskId: 'task-1', planVersion: 2, stepId: 'step-1', actionId: 'action-1', attempt: 1,
    observationId: 'observation-1', leaseId: 'lease-1', leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(), action: makePlan().steps[0]!.action }, verification: makePlan().steps[0]!.verification });
  return { data, storage, journal, command, browser: { tabId: 1, windowId: 1, documentId: 'document-1' } };
}
describe('durable extension journal', () => {
  it('survives a worker instance change without downgrading an uncertain action to prepared', async () => {
    const { journal, storage, command, browser } = fixture(); await journal.prepare(command, browser);
    await journal.transition('action-1', (record) => ({ ...record, phase: 'dispatching' }));
    const restarted = new ExecutionJournal(storage); await restarted.prepare(command, browser);
    expect((await restarted.read()).active!.phase).toBe('dispatching');
    await expect(restarted.prepare({ ...command, authorization: { ...command.authorization, actionId: 'another-action' } }, browser)).rejects.toThrow('RECONCILIATION_REQUIRED');
  });
  it('rejects changed action details and old IDs after acknowledging and rotating the active record', async () => {
    const { journal, command, browser } = fixture(); await journal.prepare(command, browser);
    await expect(journal.prepare({ ...command, authorization: { ...command.authorization, attempt: 2 } }, browser)).rejects.toThrow('ACTION_MISMATCH');
    await journal.acknowledge('action-1'); await journal.prepare({ ...command, authorization: { ...command.authorization, actionId: 'action-2' } }, browser);
    await expect(journal.prepare(command, browser)).rejects.toThrow('DUPLICATE_ACTION');
  });
  it('persists cancellation across workers and refuses new action preparation', async () => {
    const { journal, storage, command, browser } = fixture(); await journal.cancel('task-1');
    await expect(new ExecutionJournal(storage).prepare(command, browser)).rejects.toThrow('CANCELLED');
  });
  it('fails closed on corrupt storage and quota failures instead of inventing an empty journal', async () => {
    const { journal, data, storage, command, browser } = fixture(); data[JOURNAL_KEY] = { private: 'corrupt' };
    await expect(journal.prepare(command, browser)).rejects.toThrow(); expect(data[JOURNAL_KEY]).toEqual({ private: 'corrupt' });
    delete data[JOURNAL_KEY]; storage.set = async () => { throw new Error('quota'); };
    await expect(journal.prepare(command, browser)).rejects.toThrow('quota'); expect(data[JOURNAL_KEY]).toBeUndefined();
  });
  it('serializes independent updates so cancellation cannot be lost behind a dispatch checkpoint', async () => {
    const { journal, command, browser } = fixture(); await journal.prepare(command, browser);
    await Promise.all([journal.transition('action-1', (record) => ({ ...record, phase: 'dispatching' })), journal.cancel('task-1')]);
    const state = await journal.read(); expect(state.active!.phase).toBe('dispatching'); expect(state.cancellations[0]!.taskId).toBe('task-1');
  });
  it('stores matching event cursors and rejects older or unrelated task snapshots', async () => {
    const { journal, data } = fixture(); const task = makeTask(); task.currentContext = makeObservation();
    data.clickflowTaskId = task.id; await journal.checkpoint({ ...task, revision: 9 }); await journal.checkpoint({ ...task, revision: 8 });
    expect((data[CHECKPOINT_KEY] as { task: { revision: number }; eventId: string }).task.revision).toBe(9);
    expect((data[CHECKPOINT_KEY] as { eventId: string }).eventId).toBe(`${task.id}_9`);
    data.clickflowTaskId = 'new-task'; await journal.checkpoint({ ...task, revision: 10 }); expect((data[CHECKPOINT_KEY] as { task: { revision: number } }).task.revision).toBe(9);
  });
});
