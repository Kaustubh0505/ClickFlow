import express from 'express';
import { taskRoutes } from './execution/routes.js';
import type { TaskService } from './execution/task-service.js';
import { healthResponseSchema } from '@clickflow/shared';
import type { BackendConfig } from './config.js';
import { bearer, extensionOrigin, type PairingStore } from './execution/pairing.js';

/** Public health plus authenticated task routes when execution services are supplied. */
export function createApp(config: Pick<BackendConfig, 'MODEL_NAME'> & Partial<Pick<BackendConfig, 'MODEL_BASE_URL'>>, execution?: { tasks: TaskService; accessToken: string; pairing?: PairingStore }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (origin) {
      if (!['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin) && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        response.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Origin is not permitted.' } });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-ClickFlow-Extension');
      response.status(204).end(); return;
    }
    next();
  });
  app.get('/api/health', (_request, response) => {
    response.json(healthResponseSchema.parse({
      status: 'ok', service: 'clickflow-backend', version: '0.2.0', phase: 9,
      model: { name: config.MODEL_NAME, integration: 'backend_planner', ...(config.MODEL_BASE_URL ? { endpoint: new URL(config.MODEL_BASE_URL).origin + new URL(config.MODEL_BASE_URL).pathname } : {}) },
      capabilities: { planning: !!execution, browserExecution: !!execution, durableStorage: true },
    }));
  });
  if (execution?.pairing) {
    app.post('/api/pair', express.json({ limit: '1kb' }), async (request, response) => {
      try { response.json({ token: await execution.pairing!.pair(extensionOrigin(request), bearer(request)) }); }
      catch (error) { const limited = error instanceof Error && error.message === 'PAIRING_RATE_LIMIT'; response.status(limited ? 429 : 401).json({ error: { code: limited ? 'PAIRING_RATE_LIMIT' : 'UNAUTHORIZED', message: 'Pairing failed. Use the private setup token from .data/extension-token in the installed extension.' } }); }
    });
    app.post('/api/pair/revoke', async (request, response) => {
      try { await execution.pairing!.revoke(extensionOrigin(request), bearer(request)); response.status(204).end(); }
      catch { response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'This pairing is not valid.' } }); }
    });
  }
  if (execution) app.use('/api/tasks', express.json({ limit: '3mb' }), taskRoutes(execution.tasks, execution.accessToken, execution.pairing));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
    response.status(status).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid or oversized JSON request.' } });
  });
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'This API is not available in Phase 4.' } });
  });
  return app;
}
