import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPageAccess, changeOrigin } from './access.js';
const origin = 'https://example.com';
afterEach(() => vi.unstubAllGlobals());
function chromeMock(origins: string[], permitted = true) {
  const stored = { clickflowOrigins: origins };
  vi.stubGlobal('chrome', { storage: { local: { get: async () => stored, set: async (value: typeof stored) => Object.assign(stored, value) } },
    permissions: { contains: async () => permitted }, tabs: { query: async () => [{ url: `${origin}/page` }] } });
  return stored;
}
describe('explicit site access', () => {
  it('denies Chrome host access without app consent', async () => {
    chromeMock([]); await expect(assertPageAccess(`${origin}/page`)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });
  it('denies revoked Chrome permissions even with saved consent', async () => {
    chromeMock([origin], false); await expect(assertPageAccess(`${origin}/page`)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });
  it('grants only the current origin and revocation removes access', async () => {
    const stored = chromeMock([]); await changeOrigin(origin, true); expect(stored.clickflowOrigins).toEqual([origin]);
    await assertPageAccess(`${origin}/page`);
    await expect(changeOrigin('https://other.example', true)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    await changeOrigin(origin, false); await expect(assertPageAccess(`${origin}/page`)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });
  it('consent for one port does not authorize another port', async () => {
    chromeMock(['http://127.0.0.1:4173']); await expect(assertPageAccess('http://127.0.0.1:5173/sites/page')).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });
});
