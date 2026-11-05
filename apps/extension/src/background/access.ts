import { isFixtureUrl, isSupportedPageUrl, originPattern } from '@clickflow/shared';
import { BrowserToolError } from '../browser/errors.js';

export async function assertPageAccess(url: string): Promise<void> {
  if (!isSupportedPageUrl(url)) throw new BrowserToolError('UNSUPPORTED_PAGE');
  if (isFixtureUrl(url)) return;
  const origin = new URL(url).origin;
  const stored = await chrome.storage.local.get('clickflowOrigins');
  const origins: unknown = stored.clickflowOrigins;
  if (!Array.isArray(origins) || !origins.includes(origin)
    || !await chrome.permissions.contains({ origins: [originPattern(origin)] })) throw new BrowserToolError('PERMISSION_REQUIRED');
}

export async function changeOrigin(origin: string, grant: boolean): Promise<void> {
  const pattern = originPattern(origin);
  if (grant) {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab?.url || new URL(tab.url).origin !== origin || !await chrome.permissions.contains({ origins: [pattern] })) throw new BrowserToolError('PERMISSION_REQUIRED');
  }
  const stored = await chrome.storage.local.get('clickflowOrigins');
  const origins = new Set<string>(Array.isArray(stored.clickflowOrigins) ? stored.clickflowOrigins.filter((value): value is string => typeof value === 'string') : []);
  if (grant) origins.add(origin); else origins.delete(origin);
  await chrome.storage.local.set({ clickflowOrigins: [...origins].slice(-100) });
}
