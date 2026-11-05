import { activeTaskResponseSchema, taskEventSchema, taskStateSchema, type TaskState } from '@clickflow/shared';
import { BACKEND_URL } from './backend.js';
import { extensionHeaders } from './pairing.js';
export class TaskApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function request(path: string, token: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10_000): Promise<Response> {
  let response: Response;
  try { response = await fetch(`${BACKEND_URL}/api/tasks${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
    headers: { ...extensionHeaders(), Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  }); } catch (error) {
    if (signal?.aborted) throw error;
    throw new TaskApiError('BACKEND_OFFLINE', 'Cannot reach the local backend. Run npm run dev in the ClickFlow folder, then reconnect. Your checkpoint is retained.');
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new TaskApiError(result?.error?.code ?? 'BACKEND_ERROR', result?.error?.message ?? `Backend returned HTTP ${response.status}. Refresh before retrying.`);
  }
  return response;
}
export async function taskRequest(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<TaskState> {
  return taskStateSchema.parse(await (await request(path, token, body, signal)).json());
}
export async function activeTask(token: string, signal?: AbortSignal): Promise<TaskState | null> {
  return activeTaskResponseSchema.parse(await (await request('', token, undefined, signal)).json()).task;
}
export async function taskEvent(id: string, revision: number, token: string, signal: AbortSignal): Promise<TaskState | null> {
  const cursor = revision >= 0 ? `afterEventId=${encodeURIComponent(`${id}_${revision}`)}` : 'afterRevision=-1';
  const response = await request(`/${id}/events?${cursor}`, token, undefined, signal, 5000);
  if (response.status === 204) return null;
  const event = taskEventSchema.parse(await response.json());
  if (event.type !== 'task_snapshot' || event.id !== `${id}_${event.taskRevision}`) throw new Error('Unexpected event cursor.');
  return event.task;
}
