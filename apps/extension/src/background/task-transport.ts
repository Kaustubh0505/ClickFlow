import { taskStateSchema, type TaskState } from '@clickflow/shared';
import { BACKEND_URL } from '../services/backend.js';
import { extensionHeaders } from '../services/pairing.js';

export class TransportError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
export async function backendTask(path: string, body?: unknown): Promise<TaskState> {
  const stored = await chrome.storage.local.get('clickflowAccessToken');
  if (typeof stored.clickflowAccessToken !== 'string') throw new TransportError('UNAUTHORIZED', 'Pair this extension before reconnecting.');
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/api/tasks${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
      headers: { ...extensionHeaders(), Authorization: `Bearer ${stored.clickflowAccessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
  } catch { throw new TransportError('BACKEND_OFFLINE', 'Backend disconnected. The durable checkpoint is retained; no new action will be sent.', true); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    const code = body?.error?.code ?? 'BACKEND_ERROR';
    const messages: Record<string, string> = {
      UNAUTHORIZED: 'Local pairing is invalid. Save connection again; the checkpoint is retained.',
      RECONCILIATION_REQUIRED: 'An action outcome remains uncertain. Resume can inspect it without repeating it; Stop if it cannot be resolved.',
      TAB_RELINK_REQUIRED: 'Return to the original tab or explicitly choose Use this active tab with the exact expected URL.',
      LIMIT_REACHED: 'The task safety budget is exhausted. Resume does not reset limits.',
      STALE_TASK: 'The checkpoint changed. Reconnect before continuing.',
      STALE_PLAN: 'Open the exact expected page before resuming the interrupted initial plan.',
      NOT_READY: 'This task cannot resume in its current state. Inspect the checkpoint.',
    };
    throw new TransportError(code, messages[code] ?? 'The backend could not accept this checkpoint. Inspect before continuing.', response.status >= 500 || response.status === 429);
  }
  try { return taskStateSchema.parse(await response.json()); }
  catch { throw new TransportError('INVALID_RESPONSE', 'The backend returned an invalid checkpoint. No dispatch is permitted.'); }
}
