import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PairingStore } from './pairing.js';
import { createApp } from '../app.js';
import { AtomicFileTaskStore } from '../state/atomic-file-task-store.js';
import { TaskService } from './task-service.js';
import { makePlan } from '../../../../tests/fixtures.js';

let directory: string; let pairing: PairingStore; let server: Server; let base: string;
const setup = 'a'.repeat(64); const origin = `chrome-extension://${'b'.repeat(32)}`; const other = `chrome-extension://${'c'.repeat(32)}`;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clickflow-pair-')); pairing = new PairingStore(directory, setup); await pairing.initialize();
  const store = new AtomicFileTaskStore(directory); await store.initialize();
  server = createApp({ MODEL_NAME: 'mock' }, { tasks: new TaskService(store, { generate: async () => makePlan() }), accessToken: setup, pairing }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeIdleConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
function call(path: string, token: string, caller?: string, method = 'GET', extra: Record<string, string> = {}) {
  return fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(caller ? { 'X-ClickFlow-Extension': caller } : {}), ...extra } });
}
describe('production pairing HTTP boundary', () => {
  it('exchanges setup for an origin-bound session; setup and missing/wrong origins cannot access tasks', async () => {
    expect((await call('/tasks/missing', setup, origin)).status).toBe(401);
    expect((await call('/pair', setup, undefined, 'POST')).status).toBe(401);
    const response = await call('/pair', setup, origin, 'POST'); expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string }; expect(token).not.toBe(setup);
    expect((await call('/tasks/missing', token, origin)).status).toBe(404);
    expect((await call('/tasks/missing', token)).status).toBe(401);
    expect((await call('/tasks/missing', token, other)).status).toBe(401);
    expect((await call('/tasks/missing', token, origin, 'GET', { Origin: 'http://127.0.0.1:5173' })).status).toBe(401);
    expect((await call('/tasks/missing', token, origin, 'GET', { Origin: other })).status).toBe(401);
  });
  it('persists only hashes privately, survives restart, rotates and revokes', async () => {
    const token = await pairing.pair(origin, setup);
    const serialized = await readFile(join(directory, 'pairing.json'), 'utf8'); expect(serialized).not.toContain(token); expect(serialized).not.toContain(setup);
    expect((await stat(join(directory, 'pairing.json'))).mode & 0o777).toBe(0o600);
    const restarted = new PairingStore(directory, setup); await restarted.initialize(); expect(restarted.authenticate(origin, token)).toBe(true);
    const rotated = await restarted.pair(origin, token); expect(restarted.authenticate(origin, token)).toBe(false);
    await restarted.revoke(origin, rotated); expect(restarted.authenticate(origin, rotated)).toBe(false);
  });
  it('revokes through HTTP and rejects replay and unrelated website origins', async () => {
    const token = await pairing.pair(origin, setup);
    expect((await call('/pair/revoke', token, origin, 'POST')).status).toBe(204);
    expect((await call('/tasks/missing', token, origin)).status).toBe(401);
    expect((await call('/pair', setup, origin, 'POST', { Origin: 'https://evil.example' })).status).toBe(403);
  });
  it('bounds pairing attempts and request payloads', async () => {
    for (let index = 0; index < 10; index++) await call('/pair', 'd'.repeat(64), origin, 'POST');
    expect((await call('/pair', setup, origin, 'POST')).status).toBe(429);
    const response = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oversized: 'x'.repeat(2000) }) }); expect(response.status).toBe(413);
  });
});
