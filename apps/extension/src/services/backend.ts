import { healthResponseSchema } from '@clickflow/shared';
import type { HealthResponse } from '@clickflow/shared';

export const BACKEND_URL = 'http://127.0.0.1:3001';

export async function checkBackend(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${BACKEND_URL}/api/health`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}.`);
  return healthResponseSchema.parse(await response.json());
}
