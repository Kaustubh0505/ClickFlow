import type { TaskState } from '@clickflow/shared';
import { ExecutionJournal } from './journal.js';
import { backendTask, TransportError } from './task-transport.js';

/** Retries only idempotent checkpoint/cancellation delivery. Never retries a browser action. */
export class OutcomeOutbox {
  private flushing: Promise<void> | null = null;
  constructor(private readonly journal: ExecutionJournal, private readonly request: typeof backendTask = backendTask) {}
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = null; }); return this.flushing;
  }
  private async retry(path: string, body?: unknown): Promise<TaskState> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(path, body); }
      catch (error) {
        if (!(error instanceof TransportError) || !error.retryable || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  private async run() {
    try {
      let state = await this.journal.read();
      const awaitingCreation = new Set<string>();
      for (const intent of state.cancellations.filter((entry) => !entry.acknowledged)) {
        let task: TaskState;
        try { task = await this.retry(`/${intent.taskId}/stop`, {}); }
        catch (error) { if (error instanceof TransportError && error.code === 'NOT_FOUND') { awaitingCreation.add(intent.taskId); continue; } throw error; }
        if (!task.cancellationRequested && !['completed', 'failed'].includes(task.status)) throw new TransportError('INVALID_RESPONSE', 'Cancellation was not acknowledged.');
        await this.journal.checkpoint(task);
        await this.journal.update((current) => ({ ...current, cancellations: current.cancellations.map((entry) => entry.taskId === intent.taskId ? { ...entry, acknowledged: true } : entry) }));
      }
      state = await this.journal.read();
      const record = state.active;
      if (!record || record.phase === 'acknowledged') return;
      if (awaitingCreation.has(record.command.authorization.taskId)) return;
      let task: TaskState;
      if (record.phase === 'outcome_ready' && record.result) task = await this.retry(`/${record.command.authorization.taskId}/outcome`, { result: record.result });
      else if (record.phase === 'reconciliation_ready' && record.report) {
        const current = await this.retry(`/${record.command.authorization.taskId}`);
        task = await this.retry(`/${current.id}/reconcile`, { expectedRevision: current.revision, report: record.report, allowTabRelink: record.allowTabRelink });
      } else return;
      await this.journal.checkpoint(task);
      if (task.actionHistory.some((entry) => entry.authorization.actionId === record.command.authorization.actionId)) await this.journal.acknowledge(record.command.authorization.actionId);
      else throw new TransportError('INVALID_RESPONSE', 'Outcome delivery was not acknowledged.');
    } catch (error) {
      const safe = error instanceof TransportError ? { code: error.code, message: error.message } : { code: 'JOURNAL_ERROR', message: 'The checkpoint could not be synchronized. No action was repeated.' };
      await this.journal.update((state) => ({ ...state, lastError: safe }));
    }
  }
}
