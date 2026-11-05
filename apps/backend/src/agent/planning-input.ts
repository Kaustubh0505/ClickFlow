import { z } from 'zod';
import { containsSensitiveText, goalCheckSchema, isSupportedPageUrl, observationSchema, textSchema } from '@clickflow/shared';

/** Raw images are transient transport only, never part of TaskState or logs. */
export const planningInputSchema = z.strictObject({
  originalRequest: textSchema,
  observation: observationSchema,
  constraints: z.array(textSchema).max(20).default([]),
  screenshot: z.strictObject({
    id: z.string().max(96),
    dataUrl: z.string().max(2_000_000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
  }).optional(),
}).superRefine((input, ctx) => {
  const text = [input.originalRequest, input.observation.title, input.observation.visibleText, ...input.constraints,
    ...input.observation.elements.flatMap((element) => [element.name, element.label ?? ''])].join('\n');
  if (containsSensitiveText(text) || !isSupportedPageUrl(input.observation.url)) ctx.addIssue({ code: 'custom', message: 'Remove private information before sending model context.' });
  const metadata = input.observation.screenshot;
  if ((metadata.status === 'captured') !== Boolean(input.screenshot)) ctx.addIssue({ code: 'custom', message: 'Image bytes and metadata must agree' });
  if (input.screenshot && metadata.status === 'captured') {
    if (metadata.id !== input.screenshot.id || !input.screenshot.dataUrl.startsWith(`data:${metadata.mimeType};base64,`)) ctx.addIssue({ code: 'custom', message: 'Image identity and MIME must agree' });
    if (Math.abs(Date.parse(metadata.capturedAt) - Date.parse(input.observation.capturedAt)) > 5_000) ctx.addIssue({ code: 'custom', message: 'Image capture must match observation' });
    const encoded = input.screenshot.dataUrl.split(',')[1] ?? '';
    const bytes = Buffer.from(encoded, 'base64');
    const validHeader = metadata.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!validHeader || bytes.toString('base64') !== encoded) ctx.addIssue({ code: 'custom', message: 'Invalid image encoding' });
  }
});
export type PlanningInput = z.infer<typeof planningInputSchema>;
export const completionInputSchema = planningInputSchema.safeExtend({ goalChecks: z.array(goalCheckSchema).max(30).default([]) });
export type CompletionInput = z.infer<typeof completionInputSchema>;
