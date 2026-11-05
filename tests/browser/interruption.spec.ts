import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { taskExecutionCommandSchema, type TaskExecutionCommand } from '@clickflow/shared';
import { createApp } from '../../apps/backend/src/app.js';
import { TaskService } from '../../apps/backend/src/execution/task-service.js';
import { AtomicFileTaskStore } from '../../apps/backend/src/state/atomic-file-task-store.js';
import { makePlan } from '../fixtures.js';

let context: BrowserContext; let panel: Page; let page: Page; let server: Server;
let tasks: TaskService; let store: AtomicFileTaskStore; let backend: string; let extensionId: string; let profile: string; let data: string;
let mode = 'click'; let dropOutcomes = false; let offline = false; let outcomeRequests = 0; let taskId: string | null = null;
let createConflict = false;
const token = '8'.repeat(64); const fixtureUrl = 'http://127.0.0.1:4173/fixtures/browser.html';
async function startBackend() {
  tasks = new TaskService(store, { generate: async (input) => {
    const plan = makePlan(); plan.goal = (input as { originalRequest: string }).originalRequest;
    if (mode === 'type') {
      const target = { strategy: 'role' as const, role: 'searchbox' as const, name: 'Search', exact: true };
      plan.steps[0]!.action = { type: 'type', target, text: 'laptops', timeoutMs: 1000 }; plan.steps[0]!.verification = { type: 'input_value_equals', target, value: 'laptops' };
    } else {
      plan.steps[0]!.action = { type: 'click', target: { strategy: 'role', role: 'button', name: mode === 'delay' ? 'Reveal delayed result' : 'Reveal result', exact: true }, timeoutMs: 5000 };
      plan.steps[0]!.verification = { type: 'text_present', text: mode === 'delay' ? 'Delayed result is ready.' : 'Result opened' };
    }
    if (mode === 'confirm') plan.steps[0]!.risk = 'high';
    return plan;
  } });
  await tasks.initialize(); server = createApp({ MODEL_NAME: 'mock-interruption-tests' }, { tasks, accessToken: token }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No backend address'); backend = `http://127.0.0.1:${address.port}`;
}
async function closeBackend() { server.closeIdleConnections(); await new Promise<void>((done) => server.close(() => done())); }
async function launchBrowser() {
  const extension = resolve('apps/extension/dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ...(process.env.CLICKFLOW_TEST_CHROMIUM ? { executablePath: process.env.CLICKFLOW_TEST_CHROMIUM } : {}),
    viewport: { width: 1280, height: 1100 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  await context.route('http://127.0.0.1:3001/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/outcome')) outcomeRequests++;
    if (offline || dropOutcomes && url.pathname.endsWith('/outcome')) { await route.abort('connectionfailed'); return; }
    if (createConflict && url.pathname === '/api/tasks' && route.request().method() === 'POST') {
      createConflict = false;
      const body = route.request().postDataJSON() as { input: unknown };
      await tasks.create('other-panel-task', body.input);
    }
    try { const response = await route.fetch({ url: `${backend}${url.pathname}${url.search}` }); await route.fulfill({ response }); }
    catch { await route.abort('connectionfailed').catch(() => undefined); }
  });
}
async function openPanel() { panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`); await page.bringToFront(); }
test.beforeEach(async () => {
  mode = 'click'; offline = false; dropOutcomes = false; createConflict = false; outcomeRequests = 0; taskId = null;
  data = await mkdtemp(join(tmpdir(), 'clickflow-interruption-data-')); store = new AtomicFileTaskStore(data); await store.initialize(); await startBackend();
  profile = await mkdtemp(join(tmpdir(), 'clickflow-interruption-profile-')); await launchBrowser();
  page = await context.newPage(); await page.goto(fixtureUrl); await openPanel();
  await panel.evaluate(async (value) => { await chrome.storage.local.set({ clickflowAccessToken: value }); }, token);
  await panel.reload(); await page.bringToFront();
  expect((await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' }))).ok).toBe(true);
});
test.afterEach(async () => {
  offline = false; dropOutcomes = false;
  if (taskId) await tasks.stop(taskId).catch(() => undefined);
  await context?.close(); await closeBackend();
  await rm(profile, { recursive: true, force: true }); await rm(data, { recursive: true, force: true });
});
async function generate() {
  await panel.getByLabel('What would you like to do?').fill('Use the safe fixture controls.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click(); await expect(panel.locator('.task-state')).toContainText('ready');
  taskId = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string);
}
async function prepareWithoutDispatch(): Promise<TaskExecutionCommand> {
  const observed = await panel.evaluate(async () => { const response = await chrome.runtime.sendMessage({ kind: 'get_fixture_state' }); return chrome.runtime.sendMessage({ kind: 'observe_fixture', sessionId: response.session.id, screenshot: false }); });
  let task = await tasks.get(taskId!); task = await tasks.start(task.id, task.revision, observed.session.observation); task = await tasks.authorize(task.id, task.revision, crypto.randomUUID());
  const command = taskExecutionCommandSchema.parse({ kind: 'execute_task_action', sessionId: observed.session.id, ...task.pendingAction! });
  const saved = await panel.evaluate((input) => chrome.runtime.sendMessage({ ...input, kind: 'checkpoint_task_action' }), command); expect(saved.ok).toBe(true); return command;
}
async function markDispatchUncertain() {
  const task = await tasks.get(taskId!); await tasks.claim(task.id, task.pendingAction!.authorization.actionId, task.pendingAction!.authorization.leaseId);
  await panel.evaluate(async () => {
    const stored = (await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { active: { phase: string } };
    stored.active.phase = 'dispatching'; await chrome.storage.local.set({ clickflowExecutionJournal: stored });
  });
}
test('panel closure retains a running action and restores a fresh checkpoint without replay', async () => {
  mode = 'delay'; await generate();
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { active?: { phase: string } } | undefined)?.active?.phase)).toBe('dispatching');
  await panel.close(); await expect(page.locator('#fixture-delayed-result')).toBeVisible();
  await expect.poll(async () => (await tasks.get(taskId!)).actionHistory.length).toBe(1);
  await openPanel(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Start next step' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Resume task' }).click(); await expect(panel.getByRole('button', { name: 'Start next step' })).toBeEnabled();
  expect((await tasks.get(taskId!)).actionHistory).toHaveLength(1); expect((await tasks.get(taskId!)).modelCallCount).toBe(1);
});
test('a disconnected outcome survives panel closure and is delivered once after reconnect', async () => {
  await generate(); dropOutcomes = true;
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(page.locator('#fixture-count')).toHaveText('1');
  await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { active?: { phase: string } } | undefined)?.active?.phase)).toBe('outcome_ready');
  await panel.close(); await expect.poll(() => outcomeRequests).toBeGreaterThanOrEqual(1);
  expect((await tasks.get(taskId!)).actionHistory).toHaveLength(0);
  dropOutcomes = false; await openPanel(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Resume task' }).click(); await expect(panel.getByRole('button', { name: 'Start next step' })).toBeEnabled();
  await expect(page.locator('#fixture-count')).toHaveText('1'); expect((await tasks.get(taskId!)).actionHistory).toHaveLength(1);
});
test('backend restart reconciles a prepared action without dispatch and preserves stable plan IDs', async () => {
  await generate(); await prepareWithoutDispatch(); const ids = (await tasks.get(taskId!)).plan!.steps.map((step) => step.id);
  await closeBackend(); await startBackend(); await panel.reload(); await page.bringToFront();
  await expect(panel.locator('.task-state')).toContainText('paused'); await panel.getByRole('button', { name: 'Resume task' }).click();
  await expect(panel.locator('.task-state')).toContainText('dispatch never began'); await expect(page.locator('#fixture-count')).toHaveText('0');
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1); await expect(page.locator('#fixture-count')).toHaveText('1');
  expect((await tasks.get(taskId!)).plan!.steps.map((step) => step.id)).toEqual(ids); expect((await tasks.get(taskId!)).retryCounts['step-1']).toBe(2);
  await panel.setViewportSize({ width: 390, height: 1100 }); expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/clickflow-phase-8-resume.png', fullPage: true });
});
test('closing a confirmation requires a fresh review after resume; old approval is never reused', async () => {
  mode = 'confirm'; await generate(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.getByRole('region', { name: 'Action confirmation' })).toBeVisible();
  const old = (await tasks.get(taskId!)).confirmations[0]!.challenge.id;
  await panel.close(); await openPanel(); await expect(panel.getByRole('region', { name: 'Action confirmation' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Resume task' }).click(); await expect(panel.locator('.task-state')).toContainText('dispatch never began');
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.getByRole('region', { name: 'Action confirmation' })).toBeVisible();
  expect((await tasks.get(taskId!)).confirmations.at(-1)!.challenge.id).not.toBe(old); await expect(page.locator('#fixture-count')).toHaveText('0');
  await panel.getByRole('button', { name: 'Approve this action', exact: true }).click(); await expect(page.locator('#fixture-count')).toHaveText('1');
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
});
test('a real terminated worker recovers the content result without a second click', async () => {
  mode = 'delay'; await page.locator('#fixture-delay').evaluate((element) => element.addEventListener('click', () => element.setAttribute('data-agent-clicks', String(Number(element.getAttribute('data-agent-clicks') ?? 0) + 1))));
  await generate(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { active?: { phase: string } } | undefined)?.active?.phase)).toBe('dispatching');
  await expect(page.locator('#fixture-delay')).toHaveAttribute('data-agent-clicks', '1');
  const originalWorker = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`))!;
  await originalWorker.evaluate(() => { Reflect.set(globalThis, '__clickflowCrashProbe', 'original-worker-context'); });
  const client = await context.browser()!.newBrowserCDPSession();
  const targets = await client.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${extensionId}/`));
  expect(target).toBeDefined();
  const stopped = await client.send('Target.closeTarget', { targetId: target!.targetId }); expect(stopped.success).toBe(true);
  await client.detach();
  await expect(page.locator('#fixture-delayed-result')).toBeVisible();
  expect((await tasks.get(taskId!)).actionHistory).toHaveLength(0);
  const interrupted = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { active: { result: unknown } });
  expect(interrupted.active.result).toBeNull();
  await panel.getByRole('button', { name: 'Resume task' }).click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  const restarted = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`))!;
  expect(await restarted.evaluate(() => Reflect.get(globalThis, '__clickflowCrashProbe'))).toBeUndefined();
  await expect(page.locator('#fixture-delay')).toHaveAttribute('data-agent-clicks', '1'); expect((await tasks.get(taskId!)).actionHistory).toHaveLength(1);
});
test('an uncertain click stays blocked even when its old page predicate already matches', async () => {
  await generate(); await page.locator('#fixture-reveal').click(); await prepareWithoutDispatch(); await markDispatchUncertain();
  await panel.reload(); await page.bringToFront(); await panel.getByRole('button', { name: 'Resume task' }).click();
  await expect(panel.locator('.task-state')).toContainText('may have occurred'); await expect(panel.getByRole('button', { name: 'Start next step' })).toBeDisabled();
  await expect(page.locator('#fixture-count')).toHaveText('1'); expect((await tasks.get(taskId!)).pendingAction).not.toBeNull();
});
test('an uncertain input assignment is settled from exact fresh state with no new input event', async () => {
  mode = 'type'; await generate();
  await page.locator('#fixture-search').evaluate((element) => element.addEventListener('input', () => element.setAttribute('data-input-count', String(Number(element.getAttribute('data-input-count') ?? 0) + 1))));
  await page.locator('#fixture-search').fill('laptops'); await prepareWithoutDispatch(); await markDispatchUncertain();
  await page.locator('#fixture-search').evaluate((element) => { const duplicate = element.cloneNode(true) as HTMLInputElement; duplicate.id = 'duplicate-resume-search'; duplicate.setAttribute('aria-label', 'Search'); element.parentElement!.append(duplicate); });
  await panel.reload(); await page.bringToFront(); await panel.getByRole('button', { name: 'Resume task' }).click();
  await expect(panel.locator('.task-state')).toContainText('may have occurred');
  await page.locator('#duplicate-resume-search').evaluate((element) => element.remove());
  await panel.getByRole('button', { name: 'Resume task' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1); await expect(page.locator('#fixture-search')).toHaveAttribute('data-input-count', '1');
  const task = await tasks.get(taskId!); expect(task.actionHistory[0]!.dispatchStatus).toBe('uncertain'); expect(task.reconciliationHistory.at(-1)!.resolution).toBe('state_verified'); expect(task.retryCounts['step-1']).toBe(1);
});
test('Stop survives a backend disconnect and blocks a late valid envelope before any browser action', async () => {
  await generate(); const command = await prepareWithoutDispatch(); offline = true;
  await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect.poll(() => panel.evaluate(async () => ((await chrome.storage.local.get('clickflowExecutionJournal')).clickflowExecutionJournal as { cancellations: Array<{ acknowledged: boolean }> }).cancellations[0]?.acknowledged)).toBe(false);
  const late = await panel.evaluate((input) => chrome.runtime.sendMessage(input), command); expect(late.ok).toBe(false); await expect(page.locator('#fixture-count')).toHaveText('0');
  await panel.close(); offline = false; await openPanel(); await expect(panel.locator('.task-state')).toContainText('cancelled', { timeout: 10_000 });
  expect((await tasks.get(taskId!)).cancellationRequested).toBe(true); await expect(page.locator('#fixture-count')).toHaveText('0');
});
test('a full browser restart preserves the prepared journal and requires an explicit fresh tab binding', async () => {
  await generate(); const command = await prepareWithoutDispatch();
  const oldDocument = (await tasks.get(taskId!)).currentContext!.documentId;
  await context.close(); await launchBrowser(); page = await context.newPage(); await page.goto(fixtureUrl); await openPanel();
  await expect(panel.locator('.plan-steps li')).toHaveCount(2); await expect(panel.getByRole('button', { name: 'Start next step' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: 'Use this active tab if the original tab no longer exists' }).check();
  await panel.getByRole('button', { name: 'Resume task' }).click(); await expect(panel.locator('.task-state')).toContainText('dispatch never began');
  const rebound = await tasks.get(taskId!); expect(rebound.currentContext!.documentId).not.toBe(oldDocument); expect(rebound.actionHistory[0]!.authorization.actionId).toBe(command.authorization.actionId);
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(page.locator('#fixture-count')).toHaveText('1');
});

test('a missing selected ID restores the real blocking task so Stop and a new plan work', async () => {
  await generate(); const original = taskId!;
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ clickflowTaskId: 'rejected-create-id', clickflowTaskDraft: 'Search for another item.' });
    await chrome.storage.local.remove('clickflowTaskCheckpoint');
  });
  await panel.reload(); await page.bringToFront();
  await expect(panel.getByRole('alert')).toContainText('unfinished backend task was restored');
  await expect(panel.locator('.task-state')).toContainText('Original task: Use the safe fixture controls.');
  await expect(panel.locator('.resume-checkpoint')).not.toContainText('Offline');
  expect(await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId)).toBe(original);
  expect((await tasks.get(original)).cancellationRequested).toBe(false);
  await expect(page.locator('#fixture-count')).toHaveText('0');
  await panel.setViewportSize({ width: 390, height: 1000 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/clickflow-task-restored.png', fullPage: true });
  await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('cancelled');
  expect((await tasks.get(original)).cancellationRequested).toBe(true);
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('Original task: Search for another item.');
  taskId = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string);
  expect(taskId).not.toBe(original); await expect(panel.locator('.task-state')).toContainText('ready');
});

test('a create conflict from another panel restores its checkpoint without another model request or cancellation', async () => {
  createConflict = true;
  await panel.getByLabel('What would you like to do?').fill('Use the safe fixture controls.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('unfinished backend task was restored');
  taskId = 'other-panel-task';
  expect(await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId)).toBe(taskId);
  expect(await store.list()).toHaveLength(1);
  const current = await tasks.get(taskId); expect(current.modelCallCount).toBe(1); expect(current.cancellationRequested).toBe(false);
  await expect(panel.locator('.task-state')).toContainText('ready');
  await expect(page.locator('#fixture-count')).toHaveText('0');
});

test('a missing uncreated request is cleared without calling it offline or deleting the execution journal', async () => {
  await panel.evaluate(async () => { await chrome.storage.local.set({ clickflowTaskId: 'never-created' }); });
  await panel.reload(); await page.bringToFront();
  await expect(panel.getByRole('alert')).toContainText('previous request was not created');
  await expect(panel.locator('.resume-checkpoint')).toHaveCount(0);
  expect(await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId)).toBeUndefined();
  await generate(); await expect(page.locator('#fixture-count')).toHaveText('0');
});

test('reconnect discovers the real task after an offline missing selection without scheduling any browser action', async () => {
  await generate(); const original = taskId!;
  await panel.evaluate(async () => { await chrome.storage.local.set({ clickflowTaskId: 'offline-phantom' }); await chrome.storage.local.remove('clickflowTaskCheckpoint'); });
  offline = true; await panel.reload(); await page.bringToFront();
  await expect(panel.getByRole('alert')).toContainText('Cannot reach the local backend');
  offline = false;
  await expect(panel.locator('.task-state')).toContainText('Original task: Use the safe fixture controls.', { timeout: 12_000 });
  await expect(panel.locator('.resume-checkpoint')).not.toContainText('Offline');
  await expect(panel.getByRole('button', { name: 'Start next step' })).toBeDisabled();
  expect((await tasks.get(original)).actionHistory).toHaveLength(0); await expect(page.locator('#fixture-count')).toHaveText('0');
});
