import { z } from 'zod';
import { idSchema, timestampSchema } from './primitives.js';

/** Only ordinary HTTP pages; privileged pages, credentials and secret-bearing URLs are never observed. */
export function isSupportedPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const sensitiveKey = /token|password|secret|api[_-]?key|authorization|^code$|email|phone|card|cvv|otp/i;
    const decoded = decodeURIComponent(`${url.search}${url.hash}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !['chromewebstore.google.com', 'chrome.google.com'].includes(url.hostname)
      && !Array.from(url.searchParams.keys()).some((key) => sensitiveKey.test(key))
      && !/(?:token|password|secret|api[_-]?key|authorization|code)=/i.test(decoded)
      && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(decoded);
  } catch { return false; }
}
export function originPattern(origin: string): string {
  const url = new URL(origin);
  if (!isSupportedPageUrl(origin) || url.origin !== origin) throw new Error('Unsupported origin');
  return `${url.protocol}//${url.hostname}/*`;
}
export const confirmationSchema = z.strictObject({
  id: idSchema, actionId: idSchema, observationId: idSchema, documentId: idSchema,
  origin: z.string().url().max(2000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(1000), reasons: z.array(z.string().max(200)).min(1).max(10),
  expiresAt: timestampSchema,
});
export const approvalSchema = confirmationSchema.pick({ id: true, fingerprint: true });
export type Confirmation = z.infer<typeof confirmationSchema>;

/** Shared transport guard; conservative pattern detection cannot identify every kind of private data. */
export function containsSensitiveText(value: string): boolean {
  return /\bBearer\s+[^\s<>]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d[ -]?){13,19}\b|\b(?:password|passcode|api[_ -]?key|secret|token)\s*(?::|=|\bis\b)\s*\S+/i.test(value);
}
