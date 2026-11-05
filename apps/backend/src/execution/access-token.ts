import { randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A separate local connection credential, never the model API key. Directory exists after store.initialize(). */
export async function loadAccessToken(directory: string): Promise<string> {
  const path = join(directory, 'extension-token');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32).toString('hex')); await file.sync(); } finally { await file.close(); }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local connection token file. Preserve it for inspection.');
  return token;
}
