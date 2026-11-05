import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';

const recordsSchema = z.array(z.strictObject({ origin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/), hash: z.string().regex(/^[a-f0-9]{64}$/) })).max(20);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function sameToken(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export function extensionOrigin(request: Request): string | null {
  const claimed = request.get('X-ClickFlow-Extension');
  const origin = request.get('Origin');
  if (origin && claimed && origin !== claimed) return null;
  const value = origin ?? claimed;
  return value && /^chrome-extension:\/\/[a-p]{32}$/.test(value) ? value : null;
}
export function bearer(request: Request): string { return request.get('Authorization')?.replace(/^Bearer /, '') ?? ''; }

/** Private origin-bound sessions. The setup secret is accepted only for pairing, never task APIs. */
export class PairingStore {
  private records: z.infer<typeof recordsSchema> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private attempts: number[] = [];
  constructor(private readonly directory: string, private readonly setupToken: string) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.records = recordsSchema.parse(JSON.parse(await readFile(join(this.directory, 'pairing.json'), 'utf8'))); await chmod(join(this.directory, 'pairing.json'), 0o600); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error('Pairing state is invalid; restore the private pairing file.', { cause: error }); }
  }
  authenticate(origin: string | null, token: string): boolean {
    return !!origin && this.records.some((record) => record.origin === origin && sameToken(record.hash, digest(token)));
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  private async persist(records: z.infer<typeof recordsSchema>) {
    const path = join(this.directory, 'pairing.json'); const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); this.records = records;
  }
  pair(origin: string | null, token: string): Promise<string> {
    return this.mutate(async () => {
      this.attempts = this.attempts.filter((at) => Date.now() - at < 60_000);
      if (this.attempts.length >= 10) throw new Error('PAIRING_RATE_LIMIT');
      this.attempts.push(Date.now());
      if (!origin || (!sameToken(token, this.setupToken) && !this.authenticate(origin, token))) throw new Error('UNAUTHORIZED');
      const session = randomBytes(32).toString('hex');
      const records = this.records.filter((record) => record.origin !== origin);
      if (records.length >= 20) throw new Error('PAIRING_LIMIT');
      await this.persist([...records, { origin, hash: digest(session) }]);
      return session;
    });
  }
  revoke(origin: string | null, token: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.authenticate(origin, token)) throw new Error('UNAUTHORIZED');
      await this.persist(this.records.filter((record) => record.origin !== origin));
    });
  }
}
