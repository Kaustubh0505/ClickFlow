import { actionJournalSchema, durableExecutionSchema, taskCheckpointSchema, type ActionJournal, type DurableExecution, type TaskExecutionCommand, type TaskState } from '@clickflow/shared';

export const JOURNAL_KEY = 'clickflowExecutionJournal';
export const CHECKPOINT_KEY = 'clickflowTaskCheckpoint';
type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set'>;
const empty = (): DurableExecution => ({ version: 1, active: null, receipts: [], cancellations: [], lastError: null });

export function sameIntent(left: TaskExecutionCommand, right: TaskExecutionCommand): boolean {
  const normalize = (command: TaskExecutionCommand) => {
    const { leaseExpiresAt: _expiry, ...authorization } = command.authorization; void _expiry;
    return { sessionId: command.sessionId, authorization, verification: command.verification };
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** One worker is the sole writer. Every read-modify-write is serialized; corrupt/quota failures fail closed. */
export class ExecutionJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Storage) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  async read(): Promise<DurableExecution> {
    const stored = await this.storage.get(JOURNAL_KEY);
    return stored[JOURNAL_KEY] === undefined ? empty() : durableExecutionSchema.parse(stored[JOURNAL_KEY]);
  }
  update(change: (state: DurableExecution) => DurableExecution): Promise<DurableExecution> {
    return this.serial(async () => {
      const next = durableExecutionSchema.parse(change(await this.read()));
      await this.storage.set({ [JOURNAL_KEY]: next }); return next;
    });
  }
  prepare(command: TaskExecutionCommand, browser: ActionJournal['browser']) {
    return this.update((state) => {
      if (state.cancellations.some((entry) => entry.taskId === command.authorization.taskId)) throw new Error('CANCELLED');
      if (state.receipts.some((entry) => entry.actionId === command.authorization.actionId && state.active?.command.authorization.actionId !== entry.actionId)) throw new Error('DUPLICATE_ACTION');
      if (state.active) {
        const active = state.active;
        if (active.command.authorization.actionId === command.authorization.actionId) {
          if (!sameIntent(active.command, command)) throw new Error('ACTION_MISMATCH');
          return { ...state, active: active.phase === 'prepared' ? { ...active, command, updatedAt: new Date().toISOString() } : active };
        }
        if (active.phase !== 'acknowledged') throw new Error('RECONCILIATION_REQUIRED');
      }
      return { ...state, active: { version: 1, command, browser, phase: 'prepared', updatedAt: new Date().toISOString(), result: null, report: null, allowTabRelink: false }, lastError: null };
    });
  }
  transition(actionId: string, update: (record: ActionJournal) => ActionJournal) {
    return this.update((state) => {
      if (!state.active || state.active.command.authorization.actionId !== actionId) throw new Error('ACTION_MISMATCH');
      return { ...state, active: actionJournalSchema.parse({ ...update(state.active), updatedAt: new Date().toISOString() }) };
    });
  }
  acknowledge(actionId: string, retired = false) {
    return this.update((state) => {
      const active = state.active;
      if (!active || active.command.authorization.actionId !== actionId) return state;
      const receipt = { taskId: active.command.authorization.taskId, actionId, phase: retired ? 'cancelled_unresolved' as const : 'acknowledged' as const, at: new Date().toISOString() };
      return { ...state, active: retired ? null : { ...active, phase: 'acknowledged' },
        receipts: [...state.receipts.filter((entry) => entry.actionId !== actionId), receipt].slice(-200), lastError: null };
    });
  }
  cancel(taskId: string) {
    return this.update((state) => state.cancellations.some((entry) => entry.taskId === taskId) ? state : { ...state,
      cancellations: [...state.cancellations, { taskId, requestedAt: new Date().toISOString(), acknowledged: false }].slice(-100) });
  }
  checkpoint(task: TaskState) {
    return this.serial(async () => {
      const stored = await this.storage.get([CHECKPOINT_KEY, 'clickflowTaskId']);
      if (stored.clickflowTaskId && stored.clickflowTaskId !== task.id) return;
      const previous = taskCheckpointSchema.safeParse(stored[CHECKPOINT_KEY]);
      if (previous.success && previous.data.task.id === task.id && previous.data.task.revision > task.revision) return;
      const value = taskCheckpointSchema.parse({ task, eventId: `${task.id}_${task.revision}`, savedAt: new Date().toISOString() });
      await this.storage.set({ [CHECKPOINT_KEY]: value, clickflowTaskId: task.id });
    });
  }
}
