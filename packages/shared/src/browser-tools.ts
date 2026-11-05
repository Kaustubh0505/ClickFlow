import { z } from 'zod';
import { actionSchema } from './actions.js';
import { observationSchema } from './observation.js';
import { idSchema, timestampSchema, httpUrlSchema } from './primitives.js';
import { verificationConditionSchema, verificationResultSchema } from './verification.js';
import { approvalSchema, confirmationSchema, isSupportedPageUrl } from './safety.js';
import { goalCheckRequestSchema, goalCheckSchema } from './completion.js';

export const FIXTURE_PATH = '/fixtures/browser.html';
export const FIXTURE_URL = `http://127.0.0.1:5173${FIXTURE_PATH}`;

export function isFixtureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && ['5173', '4173'].includes(url.port) && [FIXTURE_PATH, '/fixtures/details.html'].includes(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export const probeActionSchema = actionSchema.refine((action) => action.type !== 'navigate' || isSupportedPageUrl(action.url), 'Navigation requires a supported HTTP page');

export const extractionSchema = z.strictObject({ outputKey: idSchema, schemaId: z.literal('text-v1'), text: z.string().min(1).max(20_000), sourceUrl: httpUrlSchema, capturedAt: timestampSchema, observationId: idSchema });

export const probeErrorSchema = z.strictObject({ code: idSchema, message: z.string().min(1).max(500) });
export const fixtureActionResultSchema = z.strictObject({
  actionId: idSchema,
  actionType: z.enum(['observe', 'navigate', 'click', 'type', 'clear_input', 'select_option', 'scroll', 'press_key', 'wait', 'go_back', 'go_forward', 'extract_text', 'finish']),
  extraction: extractionSchema.nullable().default(null),
  dispatchStatus: z.enum(['not_dispatched', 'dispatched', 'uncertain']),
  recordedAt: timestampSchema,
  verification: verificationResultSchema.nullable(),
  observation: observationSchema.nullable(),
  error: probeErrorSchema.nullable(),
});

export const fixtureSessionSchema = z.strictObject({
  id: idSchema,
  revision: z.number().int().nonnegative(),
  tabId: z.number().int().nonnegative(),
  windowId: z.number().int().nonnegative(),
  documentId: idSchema,
  stopped: z.boolean(),
  runningActionId: idSchema.nullable(),
  attemptedActionIds: z.array(idSchema).max(50),
  observation: observationSchema,
  lastResult: fixtureActionResultSchema.nullable(),
  lastError: probeErrorSchema.nullable(),
  navigationHistory: z.strictObject({ urls: z.array(httpUrlSchema).max(100), index: z.number().int().nonnegative() }).default({ urls: [], index: 0 }),
});

export const browserToolCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('get_fixture_state') }),
  z.strictObject({ kind: z.literal('open_fixture') }),
  z.strictObject({ kind: z.literal('bind_fixture') }),
  z.strictObject({ kind: z.literal('grant_origin'), origin: z.string().max(2000) }),
  z.strictObject({ kind: z.literal('revoke_origin'), origin: z.string().max(2000) }),
  z.strictObject({ kind: z.literal('observe_fixture'), sessionId: idSchema, screenshot: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('check_goal_criteria'), sessionId: idSchema, criteria: z.array(goalCheckRequestSchema).max(30) }),
  z.strictObject({ kind: z.literal('execute_fixture'), sessionId: idSchema, actionId: idSchema, action: probeActionSchema, verification: verificationConditionSchema, approval: approvalSchema.optional() }),
  z.strictObject({ kind: z.literal('prepare_action'), sessionId: idSchema, actionId: idSchema, action: probeActionSchema, verification: verificationConditionSchema, forceConfirmation: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('stop_fixture'), sessionId: idSchema }),
]);

export const browserToolResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), session: fixtureSessionSchema.nullable(), confirmation: confirmationSchema.nullable().optional(), goalChecks: z.array(goalCheckSchema).max(30).optional(), screenshotDataUrl: z.string().max(2_000_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/).optional() }),
  z.strictObject({ ok: z.literal(false), session: fixtureSessionSchema.nullable(), error: probeErrorSchema }),
]);

const identity = {
  sessionId: idSchema, tabId: z.number().int().nonnegative(), windowId: z.number().int().nonnegative(),
  documentId: idSchema, zoom: z.number().positive().max(5),
};
export const contentCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('content_observe'), ...identity }),
  z.strictObject({ kind: z.literal('content_execute'), ...identity, actionId: idSchema, expectedObservationId: idSchema, expectedRevision: z.number().int().nonnegative(), action: probeActionSchema, verification: verificationConditionSchema, approval: approvalSchema.optional() }),
  z.strictObject({ kind: z.literal('content_prepare'), ...identity, actionId: idSchema, expectedObservationId: idSchema, expectedRevision: z.number().int().nonnegative(), action: probeActionSchema, verification: verificationConditionSchema, forceConfirmation: z.boolean() }),
  z.strictObject({ kind: z.literal('content_stop'), sessionId: idSchema }),
  z.strictObject({ kind: z.literal('content_result'), sessionId: idSchema, actionId: idSchema }),
  z.strictObject({ kind: z.literal('content_check_state'), ...identity, action: probeActionSchema, verification: verificationConditionSchema }),
  z.strictObject({ kind: z.literal('content_check_criteria'), ...identity, criteria: z.array(goalCheckRequestSchema).max(30) }),
]);
export const observationFrameSchema = z.strictObject({
  observation: observationSchema,
  screenshotSafe: z.boolean(),
});
export const contentResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed'), frame: observationFrameSchema }),
  z.strictObject({ kind: z.literal('executed'), result: fixtureActionResultSchema }),
  z.strictObject({ kind: z.literal('prepared'), confirmation: confirmationSchema.nullable() }),
  z.strictObject({ kind: z.literal('cached_result'), result: fixtureActionResultSchema.nullable() }),
  z.strictObject({ kind: z.literal('checked_state'), observation: observationSchema, verification: verificationResultSchema.nullable() }),
  z.strictObject({ kind: z.literal('checked_criteria'), observation: observationSchema, goalChecks: z.array(goalCheckSchema).max(30) }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({ kind: z.literal('error'), error: probeErrorSchema }),
]);

export type BrowserToolCommand = z.infer<typeof browserToolCommandSchema>;
export type BrowserToolResponse = z.infer<typeof browserToolResponseSchema>;
export type FixtureSession = z.infer<typeof fixtureSessionSchema>;
export type FixtureActionResult = z.infer<typeof fixtureActionResultSchema>;
export type ContentCommand = z.infer<typeof contentCommandSchema>;
export type ObservationFrame = z.infer<typeof observationFrameSchema>;
