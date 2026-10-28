import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@clickflow/shared';
import { createApp } from './app.js';

describe('Phase 1 HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    server = createApp({ MODEL_NAME: 'test-model' }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  });
  it('returns a validated, honest health response', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const health = healthResponseSchema.parse(await response.json());
    expect(health.capabilities).toEqual({ planning: false, browserExecution: false, durableStorage: true });
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('allows the local side-panel preview', async () => {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });
  it('rejects unrelated website origins', async () => {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://unrelated.example' } });
    expect(response.status).toBe(403);
  });
  it('does not expose task creation before pairing and orchestration exist', async () => {
    expect((await fetch(`${baseUrl}/api/tasks`, { method: 'POST' })).status).toBe(404);
  });
});
