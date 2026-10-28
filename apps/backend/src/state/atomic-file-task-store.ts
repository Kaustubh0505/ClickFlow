import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { idSchema, taskStateSchema } from '@clickflow/shared';
import type { TaskState } from '@clickflow/shared';
import { RevisionConflictError, StateCorruptionError } from './task-store.js';
import type { TaskStore } from './task-store.js';

const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tasks: z.array(taskStateSchema).max(1_000),
}).superRefine((snapshot, ctx) => {
  if (new Set(snapshot.tasks.map((task) => task.id)).size !== snapshot.tasks.length) {
    ctx.addIssue({ code: 'custom', message: 'Stored task IDs must be unique' });
  }
});
type Snapshot = z.infer<typeof snapshotSchema>;

/** Single backend process, one adapter instance. Writes serialize; readers see atomic snapshots. */
export class AtomicFileTaskStore implements TaskStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'tasks.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.readSnapshot();
  }

  async get(id: string): Promise<TaskState | null> {
    idSchema.parse(id);
    return (await this.readSnapshot()).tasks.find((task) => task.id === id) ?? null;
  }

  async list(): Promise<TaskState[]> {
    return (await this.readSnapshot()).tasks;
  }

  async save(input: TaskState, expectedRevision: number | null): Promise<TaskState> {
    const task = taskStateSchema.parse(input);
    const operation = this.queue.then(async () => {
      const snapshot = await this.readSnapshot();
      const current = snapshot.tasks.find((entry) => entry.id === task.id);
      if (expectedRevision === null) {
        if (current || task.revision !== 0) throw new RevisionConflictError();
      } else if (!current || current.revision !== expectedRevision || task.revision !== expectedRevision + 1) {
        throw new RevisionConflictError();
      }
      if (current && (task.originalRequest !== current.originalRequest || task.createdAt !== current.createdAt || Date.parse(task.updatedAt) < Date.parse(current.updatedAt))) {
        throw new Error('Task identity, original goal, and timestamp history must be preserved.');
      }
      const tasks = current ? snapshot.tasks.map((entry) => entry.id === task.id ? task : entry) : [...snapshot.tasks, task];
      await this.writeSnapshot(snapshotSchema.parse({ schemaVersion: 1, tasks }));
      return task;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async readSnapshot(): Promise<Snapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, tasks: [] };
      throw error;
    }
    try {
      return snapshotSchema.parse(JSON.parse(raw));
    } catch {
      throw new StateCorruptionError();
    }
  }

  private async writeSnapshot(snapshot: Snapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.directory, `.tasks-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(snapshot));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
