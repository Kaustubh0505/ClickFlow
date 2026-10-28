import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AtomicFileTaskStore } from './state/atomic-file-task-store.js';

const config = loadConfig();
const store = new AtomicFileTaskStore(config.DATA_DIR);
await store.initialize();
const server = createApp(config).listen(config.PORT, '127.0.0.1', () => {
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
