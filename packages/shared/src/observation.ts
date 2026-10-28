import { z } from 'zod';
import { httpUrlSchema, idSchema, textSchema, timestampSchema } from './primitives.js';

export const observationSchema = z.strictObject({
  id: idSchema,
  capturedAt: timestampSchema,
  tabId: z.number().int().min(0),
  windowId: z.number().int().min(0),
  frameId: z.number().int().min(0),
  documentId: idSchema,
  revision: z.number().int().min(0),
  url: httpUrlSchema,
  title: z.string().max(1_000),
  viewport: z.strictObject({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384), devicePixelRatio: z.number().positive().max(10), zoom: z.number().positive().max(5) }),
  scroll: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
  visibleText: z.string().max(20_000),
  elements: z.array(z.strictObject({
    ref: idSchema,
    role: z.string().max(100),
    name: z.string().max(500),
    label: z.string().max(500).optional(),
    tagName: z.string().max(50),
    inputType: z.string().max(50).optional(),
    visible: z.boolean(),
    enabled: z.boolean(),
    bounds: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().max(100_000), height: z.number().nonnegative().max(100_000) }),
  })).max(100),
  loading: z.enum(['loading', 'interactive', 'complete']),
  truncated: z.boolean(),
  screenshot: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('omitted'), reason: textSchema }),
    z.strictObject({ status: z.literal('captured'), id: idSchema, capturedAt: timestampSchema, width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384), mimeType: z.enum(['image/png', 'image/jpeg']), redacted: z.boolean() }),
  ]),
});

export type Observation = z.infer<typeof observationSchema>;
