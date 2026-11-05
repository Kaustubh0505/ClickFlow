import { join } from 'node:path';
import { ModelClient } from './agent/model-client.js';
import { Planner } from './agent/planner.js';
import { RecoveryPlanner } from './agent/recovery.js';
import { CompletionAssessor } from './agent/completion.js';
import { TaskService } from './execution/task-service.js';
import { loadAccessToken } from './execution/access-token.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AtomicFileTaskStore } from './state/atomic-file-task-store.js';
import { PairingStore } from './execution/pairing.js';

const config = loadConfig();
const store = new AtomicFileTaskStore(config.DATA_DIR);
await store.initialize();
const accessToken = await loadAccessToken(config.DATA_DIR);
const pairing = new PairingStore(config.DATA_DIR, accessToken);
await pairing.initialize();
const model = new ModelClient(config);
const tasks = new TaskService(store, new Planner(model), new RecoveryPlanner(model), new CompletionAssessor(model));
await tasks.initialize();
console.info(`Local extension connection token file: ${join(config.DATA_DIR, 'extension-token')} (keep private; paste into the extension).`);
const server = createApp(config, { tasks, accessToken, pairing }).listen(config.PORT, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.info(`ClickFlow backend listening at http://127.0.0.1:${address.port}`);
});
server.on('error', () => {
  console.error('Backend could not listen. Check PORT and whether another process is using it.');
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
