import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeObservation, makePlan, makeTask } from '../../../../tests/fixtures.js';
import { AtomicFileTaskStore } from './atomic-file-task-store.js';
import { RevisionConflictError, StateCorruptionError } from './task-store.js';

describe('atomic task storage', () => {
  let directory: string;
  let store: AtomicFileTaskStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clickflow-store-'));
    store = new AtomicFileTaskStore(directory);
    await store.initialize();
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('returns an empty state on first use', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });
  it('loads the complete task through a fresh store instance', async () => {
    const task = makeTask();
    await store.save(task, null);
    const restarted = new AtomicFileTaskStore(directory);
    await restarted.initialize();
    expect(await restarted.get(task.id)).toEqual(task);
  });
  it('preserves the full plan and browser context across reloads', async () => {
    const task = { ...makeTask(), status: 'ready' as const, plan: makePlan(), initialContext: makeObservation(), currentContext: makeObservation() };
    await store.save(task, null);
    const restarted = new AtomicFileTaskStore(directory);
    expect(await restarted.get(task.id)).toEqual(task);
  });
  it('requires the next exact revision', async () => {
    const task = makeTask();
    await store.save(task, null);
    await expect(store.save(task, 0)).rejects.toBeInstanceOf(RevisionConflictError);
    await store.save({ ...task, revision: 1, status: 'paused' }, 0);
    expect((await store.get(task.id))?.revision).toBe(1);
  });
  it('rejects duplicate task creation', async () => {
    await store.save(makeTask(), null);
    await expect(store.save(makeTask(), null)).rejects.toBeInstanceOf(RevisionConflictError);
  });
  it('a rejected update does not poison subsequent valid writes', async () => {
    const task = makeTask();
    await store.save(task, null);
    await expect(store.save({ ...task, revision: 2 }, 0)).rejects.toBeInstanceOf(RevisionConflictError);
    await store.save({ ...task, revision: 1, status: 'paused' }, 0);
    expect((await store.get(task.id))?.status).toBe('paused');
  });
  it('serializes competing updates so only one wins', async () => {
    const task = makeTask();
    await store.save(task, null);
    const results = await Promise.allSettled([
      store.save({ ...task, revision: 1, status: 'paused' }, 0),
      store.save({ ...task, revision: 1, status: 'cancelled' }, 0),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.get(task.id))?.revision).toBe(1);
  });
  it('preserves all tasks across concurrent creates', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.save({ ...makeTask(), id: `task-${index}` }, null)));
    expect(await store.list()).toHaveLength(10);
    expect(await readdir(directory)).toEqual(['tasks.json']);
  });
  it('does not overwrite corrupt snapshots', async () => {
    await writeFile(join(directory, 'tasks.json'), '{broken');
    await expect(store.initialize()).rejects.toBeInstanceOf(StateCorruptionError);
    await expect(store.save(makeTask(), null)).rejects.toBeInstanceOf(StateCorruptionError);
    expect(await readFile(join(directory, 'tasks.json'), 'utf8')).toBe('{broken');
  });
  it('rejects unsupported stored schema versions', async () => {
    await writeFile(join(directory, 'tasks.json'), JSON.stringify({ schemaVersion: 2, tasks: [] }));
    await expect(store.list()).rejects.toBeInstanceOf(StateCorruptionError);
  });
  it('rejects invalid state before writing', async () => {
    await expect(store.save({ ...makeTask(), status: 'completed' }, null)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it('preserves the original request', async () => {
    const task = makeTask();
    await store.save(task, null);
    await expect(store.save({ ...task, revision: 1, originalRequest: 'Changed goal' }, 0)).rejects.toThrow('original goal');
    expect((await store.get(task.id))?.originalRequest).toBe(task.originalRequest);
  });
  it('uses private file permissions on POSIX', async () => {
    await store.save(makeTask(), null);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'tasks.json'))).mode & 0o777).toBe(0o600);
  });
});
