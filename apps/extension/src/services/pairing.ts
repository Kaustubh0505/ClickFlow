import { BACKEND_URL } from './backend.js';

export function extensionHeaders() { return { 'X-ClickFlow-Extension': chrome.runtime.getURL('').replace(/\/$/, '') }; }
export async function pairBackend(token: string): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/api/pair`, { method: 'POST', headers: { ...extensionHeaders(), Authorization: `Bearer ${token.trim()}` }, credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Pairing failed. Paste the setup token from .data/extension-token; check the backend and retry.');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new Error('Invalid pairing response.');
  return body.token;
}
export async function revokePairing(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/pair/revoke`, { method: 'POST', headers: { ...extensionHeaders(), Authorization: `Bearer ${token}` }, credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if (!response.ok && response.status !== 401) throw new Error('Could not revoke pairing. Check the backend and retry.');
}
