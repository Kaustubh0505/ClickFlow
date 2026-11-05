import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activeTask, taskEvent, taskRequest } from './tasks.js';

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://' + 'a'.repeat(32) + '/' } });
});
afterEach(() => vi.unstubAllGlobals());

it('preserves NOT_FOUND from event polling instead of reporting a disconnected backend', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'NOT_FOUND', message: 'Task was not found.' } }, { status: 404 })));
  await expect(taskEvent('missing', -1, 'token', new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('distinguishes invalid pairing from an offline backend', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'UNAUTHORIZED', message: 'Pair this extension using Save connection.' } }, { status: 401 })));
  await expect(activeTask('token')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
it('provides local startup instructions for network failures without including transport details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network diagnostics')));
  await expect(taskRequest('/task', 'token')).rejects.toMatchObject({ code: 'BACKEND_OFFLINE', message: expect.stringContaining('npm run dev') });
});
it('returns an empty active-task response without inventing a checkpoint', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ task: null })));
  expect(await activeTask('token')).toBeNull();
});
it('retains no-update event responses and rejects malformed active checkpoints', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json({ task: { id: 'partial' } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await taskEvent('task', 1, 'token', new AbortController().signal)).toBeNull();
  await expect(activeTask('token')).rejects.toThrow();
});
