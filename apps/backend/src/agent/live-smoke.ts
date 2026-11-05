import { loadConfig } from '../config.js';
import { ModelClient } from './model-client.js';
import { Planner } from './planner.js';
import { ModelError } from './errors.js';

const config = loadConfig();
if (process.env.RUN_LIVE_MODEL !== '1' || !config.MODEL_API_KEY) {
  console.log('SKIPPED: set RUN_LIVE_MODEL=1 and backend MODEL_API_KEY to send a synthetic, non-sensitive vision planning request.');
} else {
  const now = new Date().toISOString();
  try {
    const plan = await new Planner(new ModelClient(config)).generate({
      originalRequest: 'Observe this synthetic white pixel test page and assess whether its title is Synthetic vision fixture.',
      constraints: ['Do not navigate, type, submit, or click. This is a non-sensitive model smoke test.'],
      observation: { id: 'smoke-observation', capturedAt: now, tabId: 0, windowId: 0, frameId: 0, documentId: 'smoke-document', revision: 0,
        url: 'http://127.0.0.1:5173/fixtures/browser.html', title: 'Synthetic vision fixture',
        viewport: { width: 1, height: 1, devicePixelRatio: 1, zoom: 1 }, scroll: { x: 0, y: 0 }, visibleText: '', elements: [], loading: 'complete', truncated: false,
        screenshot: { status: 'captured', id: 'smoke-image', capturedAt: now, width: 1, height: 1, mimeType: 'image/png', redacted: false } },
      screenshot: { id: 'smoke-image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=' },
    });
    console.log(`PASS: ${config.MODEL_NAME} accepted image input and returned a validated complete plan (${plan.steps.length} steps). No browser action was executed.`);
  } catch (error) {
    const safe = error instanceof ModelError ? error : new ModelError('PROVIDER_UNAVAILABLE');
    console.error(`${safe.code}: ${safe.message}`); process.exitCode = 1;
  }
}
