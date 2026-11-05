import { fixtureSessionSchema } from '@clickflow/shared';
import type { FixtureSession } from '@clickflow/shared';

const key = 'clickflowFixtureSession';
let queue: Promise<unknown> = Promise.resolve();

export async function readSession(): Promise<FixtureSession | null> {
  const result = await chrome.storage.session.get(key);
  if (!result[key]) return null;
  const parsed = fixtureSessionSchema.safeParse(result[key]);
  if (!parsed.success) { await chrome.storage.session.remove(key); return null; }
  return parsed.data;
}

/** Short storage transactions only: never hold the queue while an action waits. */
export function updateSession(update: (current: FixtureSession | null) => FixtureSession): Promise<FixtureSession> {
  const operation = queue.then(async () => {
    const current = await readSession();
    const session = fixtureSessionSchema.parse(update(current));
    session.revision = (current?.revision ?? 0) + 1;
    await chrome.storage.session.set({ [key]: session });
    return session;
  });
  queue = operation.catch(() => undefined);
  return operation;
}
