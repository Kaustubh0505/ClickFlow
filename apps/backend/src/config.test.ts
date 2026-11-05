import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('backend configuration', () => {
  it('runs without model credentials in Phase 1', () => {
    const config = parseConfig({});
    expect(config.PORT).toBe(3001);
    expect(config.MODEL_API_KEY).toBe('');
    expect(config.MODEL_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
  it('rejects insecure remote endpoints and unbounded retries', () => {
    expect(() => parseConfig({ MODEL_BASE_URL: 'http://example.com/api/v1' })).toThrow('MODEL_BASE_URL');
    expect(() => parseConfig({ MODEL_MAX_RETRIES: '3' })).toThrow('MODEL_MAX_RETRIES');
    expect(() => parseConfig({ MODEL_TIMEOUT_MS: '0' })).toThrow('MODEL_TIMEOUT_MS');
  });
  it('rejects invalid ports', () => expect(() => parseConfig({ PORT: '70000' })).toThrow('PORT'));
  it('rejects executable provider URLs', () => expect(() => parseConfig({ MODEL_BASE_URL: 'javascript:alert(1)' })).toThrow('MODEL_BASE_URL'));
  it('reports invalid field names without printing their values', () => {
    expect(() => parseConfig({ MODEL_BASE_URL: 'https://secret:password@example.com' })).toThrow('Invalid backend configuration: MODEL_BASE_URL.');
  });
});
