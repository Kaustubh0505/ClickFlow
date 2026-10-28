import type { TaskState } from '@clickflow/shared';

export interface TaskStore {
  initialize(): Promise<void>;
  get(id: string): Promise<TaskState | null>;
  list(): Promise<TaskState[]>;
  /** null creates revision 0; an update must increment the expected revision by one. */
  save(task: TaskState, expectedRevision: number | null): Promise<TaskState>;
}

export class RevisionConflictError extends Error {
  constructor() {
    super('Task revision conflict. Reload the current task before updating.');
    this.name = 'RevisionConflictError';
  }
}

export class StateCorruptionError extends Error {
  constructor() {
    super('Stored task state is invalid. Preserve the file for recovery; it has not been overwritten.');
    this.name = 'StateCorruptionError';
  }
}
