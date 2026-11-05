import { describe, expect, it } from 'vitest';
import { browserToolCommandSchema, isFixtureUrl, probeActionSchema } from './browser-tools.js';

describe('Phase 2 fixture boundary', () => {
  it.each(['http://127.0.0.1:5173/fixtures/browser.html', 'http://127.0.0.1:4173/fixtures/browser.html'])('permits only a known fixture URL: %s', (url) => expect(isFixtureUrl(url)).toBe(true));
  it.each([
    'https://example.com/fixtures/browser.html', 'http://127.0.0.1:3001/fixtures/browser.html',
    'http://localhost:5173/fixtures/browser.html', 'http://127.0.0.1:5173/fixtures/browser.html?token=secret',
    'http://127.0.0.1:5173/sidepanel.html', 'http://127.0.0.1.evil.test:5173/fixtures/browser.html',
    'http://user:secret@127.0.0.1:5173/fixtures/browser.html', 'chrome://settings', 'not-a-url',
    'http://127.0.0.1:5173/fixtures/browser.html#token=secret',
  ])('rejects a non-fixture URL: %s', (url) => expect(isFixtureUrl(url)).toBe(false));
  it('rejects requests that override the active tab identity', () => {
    expect(browserToolCommandSchema.safeParse({ kind: 'bind_fixture', tabId: 123 }).success).toBe(false);
  });
  it('rejects navigation until its executor is implemented', () => {
    expect(probeActionSchema.safeParse({ type: 'navigate', url: 'https://example.com' }).success).toBe(true);
    expect(probeActionSchema.safeParse({ type: 'navigate', url: 'https://example.com/?token=secret' }).success).toBe(false);
  });
  it('requires verification for manual execution', () => {
    expect(browserToolCommandSchema.safeParse({ kind: 'execute_fixture', sessionId: 'session-1', actionId: 'action-1', action: { type: 'observe' } }).success).toBe(false);
  });
  it('rejects page-provided script fields', () => {
    expect(browserToolCommandSchema.safeParse({ kind: 'observe_fixture', sessionId: 'session-1', code: 'document.cookie' }).success).toBe(false);
  });
});
