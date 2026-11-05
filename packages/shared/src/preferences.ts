import { z } from 'zod';
import { DEFAULT_LIMITS, executionLimitsSchema } from './primitives.js';

/** Preferences may tighten the backend defaults; they cannot weaken circuit breakers. */
export const newTaskLimitsSchema = executionLimitsSchema.superRefine((limits, ctx) => {
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>) {
    if (limits[key] > DEFAULT_LIMITS[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Cannot exceed the backend safety default' });
  }
});
export const preferencesSchema = z.strictObject({
  version: z.literal(1).default(1), screenshots: z.boolean().default(false),
  expandEvidence: z.boolean().default(false), limits: newTaskLimitsSchema.default(DEFAULT_LIMITS),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const DEFAULT_PREFERENCES = preferencesSchema.parse({});
