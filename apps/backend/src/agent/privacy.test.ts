import { describe, expect, it } from 'vitest';
import { makeObservation } from '../../../../tests/fixtures.js';
import { planningInputSchema } from './planning-input.js';
describe('model context privacy boundary', () => {
  const input = () => ({ originalRequest: 'Find laptops under 50000', observation: makeObservation() });
  it.each(['password: private-example', 'Bearer private-example', 'sk-privateExampleKey123456', 'person@example.com', '4111 1111 1111 1111'])('rejects recognizable private task input before inference: %s', (originalRequest) => {
    expect(planningInputSchema.safeParse({ ...input(), originalRequest }).success).toBe(false);
  });
  it('rejects unsanitized DOM and secret-bearing URLs from alternate callers', () => {
    const context = input(); context.observation.visibleText = 'person@example.com'; expect(planningInputSchema.safeParse(context).success).toBe(false);
    context.observation.visibleText = '[redacted]'; context.observation.url = 'https://example.com/?token=private'; expect(planningInputSchema.safeParse(context).success).toBe(false);
  });
  it('accepts sanitized bounded context and an ordinary task', () => expect(planningInputSchema.safeParse(input()).success).toBe(true));
});
