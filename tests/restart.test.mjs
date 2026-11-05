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

test('task persists and interruption is checkpointed once across two real backend restarts', { timeout: 20_000 }, async () => {
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
    const checkpoint = await restarted.get(fixture.id);
    assert.equal(checkpoint.status, 'paused');
    assert.equal(checkpoint.revision, 1);
    assert.equal(checkpoint.errors.length, 1);
    assert.equal(checkpoint.errors[0].code, 'INTERRUPTED');
    assert.ok(Date.parse(checkpoint.updatedAt) >= Date.parse(fixture.updatedAt));
    assert.deepEqual(checkpoint, { ...fixture, pendingAction: null, confirmations: [], reconciliationHistory: [], resumeRequired: true, planNeedsRecovery: false, planningRequestId: null, completionRequestId: null, completionRequestIds: [], completionHistory: [], dispatchClaims: [], modelCallCount: 0, recoveryAttemptCount: 0, recoveryRequestIds: [], status: 'paused', revision: 1, errors: checkpoint.errors, updatedAt: checkpoint.updatedAt });
  } finally {
    active?.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('a prepared dispatch, pairing and reconciliation receipt survive actual backend processes', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clickflow-pending-restart-'));
  let active;
  async function start() {
    const child = spawn(process.execPath, ['apps/backend/dist/server.js'], { cwd: root,
      env: { ...process.env, DATA_DIR: directory, PORT: '0', MODEL_API_KEY: '', MODEL_NAME: 'restart-test-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    const url = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Backend startup timeout')), 8000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited before readiness')); });
      child.stdout.on('data', (chunk) => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    return { child, url };
  }
  async function stop(child) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0); active = undefined; }
  try {
    const { taskStateSchema, observationSchema, initialPlanSchema } = await import('@clickflow/shared');
    const { AtomicFileTaskStore } = await import('../apps/backend/dist/state/atomic-file-task-store.js');
    const at = new Date().toISOString(); const target = { strategy: 'role', role: 'searchbox', name: 'Search', exact: true };
    const observation = observationSchema.parse({ id: 'process-observation', capturedAt: at, tabId: 1, windowId: 1, frameId: 0, documentId: 'process-document', revision: 1,
      url: 'http://127.0.0.1:4173/fixtures/browser.html', title: 'Safe fixture', viewport: { width: 1280, height: 720, devicePixelRatio: 1, zoom: 1 }, scroll: { x: 0, y: 0 }, visibleText: 'Search', elements: [], loading: 'complete', truncated: false, screenshot: { status: 'omitted', reason: 'Read-only process test' } });
    const plan = initialPlanSchema.parse({ goal: fixture.originalRequest, version: 1, currentStepId: null, goalCriteria: [{ id: 'goal-1', description: 'Search is focused' }], steps: [
      { id: 'work-1', logicalStepId: 'work-1', description: 'Focus Search', action: { type: 'click', target }, preconditions: [], expectedResult: 'Search is focused', verification: { type: 'element_focused', target }, dependencies: [], risk: 'low', status: 'pending', evidenceIds: [] },
      { id: 'finish-1', logicalStepId: 'finish-1', description: 'Assess completion', action: { type: 'finish' }, preconditions: [], expectedResult: 'Evidence assessed', verification: { type: 'semantic_assessment_required', criterion: 'Search is focused' }, dependencies: ['work-1'], risk: 'low', status: 'pending', evidenceIds: [] },
    ] });
    plan.version = 2; plan.currentStepId = 'work-1'; plan.steps[0].status = 'in_progress';
    const task = taskStateSchema.parse({ ...fixture, id: 'pending-process-task', createdAt: at, updatedAt: at, status: 'executing', initialContext: observation, currentContext: observation, plan, retryCounts: { 'work-1': 1 },
      pendingAction: { authorization: { taskId: 'pending-process-task', planVersion: 2, stepId: 'work-1', actionId: 'pending-process-action', attempt: 1, observationId: observation.id, leaseId: 'process-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), action: plan.steps[0].action, requiresConfirmation: false, protocolVersion: 2 }, verification: plan.steps[0].verification } });
    await new AtomicFileTaskStore(directory).save(task, null);
    const first = await start();
    const setup = await readFile(join(directory, 'extension-token'), 'utf8');
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const paired = await fetch(`${first.url}/api/pair`, { method: 'POST', headers: { Authorization: `Bearer ${setup.trim()}`, 'X-ClickFlow-Extension': origin } }); assert.equal(paired.status, 200);
    const { token } = await paired.json(); const headers = { Authorization: `Bearer ${token}`, 'X-ClickFlow-Extension': origin, 'Content-Type': 'application/json' };
    let checkpoint = await (await fetch(`${first.url}/api/tasks/${task.id}`, { headers })).json();
    assert.equal(checkpoint.resumeRequired, true); assert.equal(checkpoint.pendingAction.authorization.actionId, 'pending-process-action');
    const report = { id: 'process-reconciliation', actionId: 'pending-process-action', leaseId: 'process-lease', resolution: 'not_dispatched', source: 'backend_prepared',
      observation: { ...observation, id: 'process-fresh-observation', documentId: 'fresh-process-document', capturedAt: new Date().toISOString() }, verification: null };
    const reconciled = await fetch(`${first.url}/api/tasks/${task.id}/reconcile`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: checkpoint.revision, report }) }); assert.equal(reconciled.status, 200);
    checkpoint = await reconciled.json(); await stop(first.child);
    const second = await start();
    const restored = await fetch(`${second.url}/api/tasks/${task.id}`, { headers }); assert.equal(restored.status, 200); const state = await restored.json();
    assert.equal(state.pendingAction, null); assert.equal(state.plan.steps[0].status, 'pending'); assert.equal(state.retryCounts['work-1'], 1); assert.equal(state.reconciliationHistory.length, 1);
    assert.equal(state.revision, checkpoint.revision); assert.equal(state.actionHistory[0].dispatchStatus, 'not_dispatched'); await stop(second.child);
  } finally { active?.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
