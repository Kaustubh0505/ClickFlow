import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { activeTaskResponseSchema, authorizeRequestSchema, confirmationSchema, idSchema, reconcileRequestSchema, resumeRequestSchema, startTaskRequestSchema, submitOutcomeSchema, taskEventSchema } from '@clickflow/shared';
import { TaskError, type TaskService } from './task-service.js';
import { bearer, extensionOrigin, type PairingStore } from './pairing.js';
import { CompletionError } from './completion-checker.js';

export function taskRoutes(tasks: TaskService, accessToken: string, pairing?: PairingStore) {
  const router = Router();
  router.use((request, response, next) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const origin = request.headers.origin;
    // Production always supplies pairing. The direct token adapter is retained for isolated test servers.
    const valid = pairing ? pairing.authenticate(extensionOrigin(request), bearer(request)) : !(origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) && /^[a-f0-9]{64}$/.test(token) && Buffer.byteLength(token) === Buffer.byteLength(accessToken) && timingSafeEqual(Buffer.from(token), Buffer.from(accessToken));
    if (!valid) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Pair this extension using Save connection. The setup token cannot access production tasks directly.' } }); return;
    }
    next();
  });
  router.get('/', async (_request, response) => { response.json(activeTaskResponseSchema.parse({ task: await tasks.getActive() })); });
  router.post('/', async (request, response) => {
    const body = z.strictObject({ taskId: idSchema, input: z.unknown(), limits: z.unknown().optional() }).parse(request.body);
    response.status(202).json(await tasks.create(body.taskId, body.input, body.limits));
  });
  router.get('/:id', async (request, response) => { response.json(await tasks.get(idSchema.parse(request.params.id))); });
  router.get('/:id/events', async (request, response) => {
    const task = await tasks.get(idSchema.parse(request.params.id));
    const eventId = `${task.id}_${task.revision}`;
    if (request.query.afterEventId !== undefined) {
      const cursor = z.string().max(128).regex(/^[a-zA-Z0-9_-]+_[0-9]+$/).parse(request.query.afterEventId);
      if (cursor.slice(0, cursor.lastIndexOf('_')) !== task.id) throw new TaskError('INVALID_CURSOR', 'Event cursor belongs to another task.', 400);
      if (cursor === eventId) { response.status(204).end(); return; }
    } else if (request.query.afterRevision === String(task.revision)) { response.status(204).end(); return; }
    response.json(taskEventSchema.parse({ id: `${task.id}_${task.revision}`, taskId: task.id, taskRevision: task.revision, at: task.updatedAt, type: 'task_snapshot', task }));
  });
  router.post('/:id/start', async (request, response) => {
    const body = startTaskRequestSchema.parse(request.body);
    response.json(await tasks.start(idSchema.parse(request.params.id), body.expectedRevision, body.observation));
  });
  router.post('/:id/authorize', async (request, response) => {
    const body = authorizeRequestSchema.parse(request.body);
    response.json(await tasks.authorize(idSchema.parse(request.params.id), body.expectedRevision, body.actionId));
  });
  router.post('/:id/claim', async (request, response) => {
    const body = z.strictObject({ actionId: idSchema, leaseId: idSchema }).parse(request.body);
    response.json(await tasks.claim(idSchema.parse(request.params.id), body.actionId, body.leaseId));
  });
  router.post('/:id/outcome', async (request, response) => {
    response.json(await tasks.outcome(idSchema.parse(request.params.id), submitOutcomeSchema.parse(request.body).result));
  });
  router.post('/:id/review', async (request, response) => {
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), challenge: confirmationSchema, approve: z.boolean() }).parse(request.body);
    response.json(await tasks.review(idSchema.parse(request.params.id), body.expectedRevision, body.challenge, body.approve));
  });
  router.post('/:id/stop', async (request, response) => { response.json(await tasks.stop(idSchema.parse(request.params.id))); });
  router.post('/:id/resume', async (request, response) => {
    const body = resumeRequestSchema.parse(request.body);
    response.json(await tasks.resume(idSchema.parse(request.params.id), body.expectedRevision, body.observation, body.allowTabRelink));
  });
  router.post('/:id/reconcile', async (request, response) => {
    const body = reconcileRequestSchema.parse(request.body);
    response.json(await tasks.reconcile(idSchema.parse(request.params.id), body.expectedRevision, body.report, body.allowTabRelink));
  });
  router.post('/:id/recover', async (request, response) => {
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), requestId: idSchema, context: z.unknown() }).parse(request.body);
    response.status(202).json(await tasks.recover(idSchema.parse(request.params.id), body.expectedRevision, body.requestId, body.context));
  });
  router.post('/:id/assess', async (request, response) => {
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), requestId: idSchema, context: z.unknown() }).parse(request.body);
    response.status(202).json(await tasks.assess(idSchema.parse(request.params.id), body.expectedRevision, body.requestId, body.context));
  });
  router.use((error: unknown, _request: import('express').Request, response: import('express').Response, _next: import('express').NextFunction) => {
    void _next;
    if (error instanceof TaskError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof CompletionError) { response.status(409).json({ error: { code: 'UNSUPPORTED_COMPLETION', message: error.message } }); return; }
    if (error instanceof z.ZodError) { response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Request does not match the task protocol.' } }); return; }
    response.status(500).json({ error: { code: 'STATE_ERROR', message: 'The task transition could not be stored. Inspect the last checkpoint; do not repeat an uncertain action.' } });
  });
  return router;
}
