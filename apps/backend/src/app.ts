import express from 'express';
import { healthResponseSchema } from '@clickflow/shared';
import type { BackendConfig } from './config.js';

/** Health only in Phase 1: no unpaired task, storage, model, or execution routes. */
export function createApp(config: Pick<BackendConfig, 'MODEL_NAME'>) {
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
    next();
  });
  app.get('/api/health', (_request, response) => {
    response.json(healthResponseSchema.parse({
      status: 'ok', service: 'clickflow-backend', version: '0.1.0', phase: 1,
      model: { name: config.MODEL_NAME, integration: 'not_implemented' },
      capabilities: { planning: false, browserExecution: false, durableStorage: true },
    }));
  });
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'This API is not available in Phase 1.' } });
  });
  return app;
}
