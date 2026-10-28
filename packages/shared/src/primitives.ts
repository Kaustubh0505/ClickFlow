import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const timestampSchema = z.iso.datetime({ offset: true });
export const textSchema = z.string().trim().min(1).max(4_000);
export const httpUrlSchema = z.url().max(4_096).refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Only HTTP(S) URLs without embedded credentials are supported');

export const stepStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'skipped', 'blocked']);
export const riskSchema = z.enum(['low', 'medium', 'high']);
export const taskStatusSchema = z.enum([
  'planning', 'ready', 'executing', 'waiting_for_page', 'waiting_for_model',
  'awaiting_confirmation', 'recovering', 'paused', 'cancelled', 'failed', 'completed',
]);

export const executionLimitsSchema = z.strictObject({
  maxAttemptsPerStep: z.number().int().min(1).max(5).default(2),
  maxActions: z.number().int().min(1).max(200).default(50),
  maxRecoveries: z.number().int().min(0).max(20).default(5),
  maxModelCalls: z.number().int().min(1).max(100).default(15),
  taskTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  actionTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  modelTimeoutMs: z.number().int().min(1_000).max(180_000).default(60_000),
});

export const DEFAULT_LIMITS = Object.freeze(executionLimitsSchema.parse({}));
export const DEFAULT_MODEL_NAME = 'nvidia/nemotron-3.5-super-vl:free';
export const DEFAULT_MODEL_BASE_URL = 'https://openrouter.ai/api/v1';
