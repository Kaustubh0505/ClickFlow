import { describe, expect, it } from 'vitest';
import { isSupportedPageUrl, originPattern } from './safety.js';
describe('normal website boundary', () => {
  it.each(['https://example.com/search?q=laptop', 'http://127.0.0.1:4173/sites/safety.html'])('supports ordinary pages: %s', (url) => expect(isSupportedPageUrl(url)).toBe(true));
  it.each(['chrome://settings', 'about:blank', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://chromewebstore.google.com/detail/test', 'https://example.com/#token=private', 'https://example.com/?api_key=private', 'https://example.com/?%74oken=private', 'https://example.com/?q=person%40example.com'])('rejects privileged or secret URLs: %s', (url) => expect(isSupportedPageUrl(url)).toBe(false));
  it('Chrome patterns omit ports; app consent retains the exact origin separately', () => {
    expect(originPattern('http://127.0.0.1:4173')).toBe('http://127.0.0.1/*');
    expect(() => originPattern('https://example.com/path')).toThrow();
  });
});
