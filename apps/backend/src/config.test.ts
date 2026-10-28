import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('backend configuration', () => {
  it('runs without model credentials in Phase 1', () => {
    const config = parseConfig({});
    expect(config.PORT).toBe(3001);
    expect(config.MODEL_API_KEY).toBe('');
    expect(config.MODEL_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
  it('rejects invalid ports', () => expect(() => parseConfig({ PORT: '70000' })).toThrow('PORT'));
  it('rejects executable provider URLs', () => expect(() => parseConfig({ MODEL_BASE_URL: 'javascript:alert(1)' })).toThrow('MODEL_BASE_URL'));
  it('reports invalid field names without printing their values', () => {
    expect(() => parseConfig({ MODEL_BASE_URL: 'https://secret:password@example.com' })).toThrow('Invalid backend configuration: MODEL_BASE_URL.');
  });
});
