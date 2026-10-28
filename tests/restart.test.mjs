import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/task.json', import.meta.url), 'utf8'));

test('persisted task survives an actual backend process restart', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clickflow-restart-'));
  let active;
  async function start() {
    const child = spawn(process.execPath, ['apps/backend/dist/server.js'], {
      cwd: root,
      env: { ...process.env, DATA_DIR: directory, PORT: '0', MODEL_API_KEY: '', MODEL_NAME: 'restart-test-model' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active = child;
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    const baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 8_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Backend exited before readiness: ${errors}`)); });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    return child;
  }
  async function stop(child) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
    active = undefined;
  }
  try {
    const { AtomicFileTaskStore } = await import('../apps/backend/dist/state/atomic-file-task-store.js');
    // Seed through the storage interface: no unauthenticated test-only HTTP write route.
    await new AtomicFileTaskStore(directory).save(fixture, null);
    await stop(await start());
    await stop(await start());
    const restarted = new AtomicFileTaskStore(directory);
    await restarted.initialize();
    assert.deepEqual(await restarted.get(fixture.id), fixture);
  } finally {
    active?.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
