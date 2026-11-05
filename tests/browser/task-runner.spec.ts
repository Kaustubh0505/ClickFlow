import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { Planner } from '../../apps/backend/src/agent/planner.js';
import { ModelClient } from '../../apps/backend/src/agent/model-client.js';
import { loadConfig } from '../../apps/backend/src/config.js';
import { createApp } from '../../apps/backend/src/app.js';
import { TaskService } from '../../apps/backend/src/execution/task-service.js';
import { AtomicFileTaskStore } from '../../apps/backend/src/state/atomic-file-task-store.js';
import { makePlan } from '../fixtures.js';
import type { Plan, PlanPatch } from '@clickflow/shared';

let context: BrowserContext; let panel: Page; let page: Page; let profile: string; let data: string;
let server: Server; let tasks: TaskService; let backend: string; let extensionId: string;
let mode = 'focus'; let modelCalls = 0;
let recoveryCalls = 0; let recoveryReturned = false;
const token = 'c'.repeat(64);
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'clickflow-phase4-browser-'));
  data = await mkdtemp(join(tmpdir(), 'clickflow-phase4-data-'));
  const store = new AtomicFileTaskStore(data); await store.initialize();
  tasks = new TaskService(store, { generate: async (input: unknown, signal?: AbortSignal) => {
    modelCalls++;
    if (mode === 'live') return new Planner(new ModelClient(loadConfig())).generate(input, signal);
    const goal = (input as { originalRequest: string }).originalRequest;
    if (mode === 'slow') await new Promise<void>((done) => { const timer = setTimeout(done, 800); signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
    const plan = makePlan(); plan.goal = goal;
    if (mode.startsWith('recover')) {
      plan.steps[0]!.description = 'Open the safe result';
      plan.steps[0]!.action = { type: 'click', target: { strategy: 'role', role: 'button', name: 'Reveal result', exact: true }, timeoutMs: 1000 };
      plan.steps[0]!.verification = { type: 'text_present', text: 'Result opened' };
      const failing = structuredClone(plan.steps[0]!); failing.id = 'recover-step'; failing.logicalStepId = 'recover-step'; failing.description = 'Focus Search after a layout change'; failing.dependencies = ['step-1'];
      failing.action = { type: 'click', target: { strategy: 'role', role: 'searchbox', name: 'Missing Search', exact: true }, timeoutMs: 500 };
      failing.verification = { type: 'element_focused', target: { strategy: 'role', role: 'searchbox', name: 'Search', exact: true } };
      plan.steps[1]!.dependencies = ['recover-step']; plan.steps.splice(1, 0, failing);
    }
    if (mode === 'navigation-extraction') {
      const url = new URL('/fixtures/details.html', (input as { observation: { url: string } }).observation.url).href;
      plan.steps[0]!.description = 'Open fixture details';
      plan.steps[0]!.action = { type: 'navigate', url, timeoutMs: 5000 };
      plan.steps[0]!.verification = { type: 'url_matches', url, match: 'exact' };
      const extra = structuredClone(plan.steps[0]!);
      extra.id = 'extract-step'; extra.logicalStepId = 'extract-step'; extra.description = 'Extract the product details'; extra.dependencies = ['step-1'];
      extra.action = { type: 'extract_text', target: { strategy: 'text', text: 'Aster laptop: 16 GB RAM, 512 GB storage.', exact: true }, outputKey: 'product', maxCharacters: 200, timeoutMs: 1000 };
      extra.verification = { type: 'extracted_data_matches_schema', outputKey: 'product', schemaId: 'text-v1' };
      plan.steps[1]!.dependencies = ['extract-step']; plan.steps.splice(1, 0, extra);
    }
    if (mode === 'type') {
      const target = { strategy: 'label' as const, label: 'Controlled query', exact: true };
      plan.steps[0]!.action = { type: 'type', target, text: 'phase four', timeoutMs: 1000 };
      plan.steps[0]!.verification = { type: 'input_value_equals', target, value: 'phase four' };
    }
    if (mode === 'reveal') {
      plan.steps[0]!.action = { type: 'click', target: { strategy: 'role', role: 'button', name: 'Reveal result', exact: true }, timeoutMs: 1000 };
      plan.steps[0]!.verification = { type: 'text_present', text: 'Result opened' };
    }
    if (mode === 'fail') {
      plan.steps[0]!.action = { type: 'click', target: { strategy: 'role', role: 'button', name: 'No visible effect', exact: true }, timeoutMs: 200 };
      plan.steps[0]!.verification = { type: 'text_present', text: 'This outcome never appears' };
    }
    return plan as Plan;
  } }, { update: async (task, _context, signal): Promise<PlanPatch> => {
    recoveryCalls++;
    if (!mode.startsWith('recover')) throw new Error('Mock recovery intentionally unavailable for this case');
    if (mode === 'recover-slow') await new Promise<void>((done) => { const timer = setTimeout(done, 1500); signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true }); });
    recoveryReturned = true;
    const old = task.plan!.steps.find((step) => step.id === 'recover-step')!;
    return { basePlanVersion: task.plan!.version, modifiedSteps: [{ ...old, status: 'pending', action: { type: 'click', target: { strategy: 'role', role: 'searchbox', name: 'Search', exact: true }, timeoutMs: 1000 } }], insertedSteps: [], stepUpdates: [], evidenceIds: [], replanRequired: true, completionAssessmentRequested: false, explanation: 'The old Search name is missing. Resolve the current Search control and preserve completed work.' };
  } });
  server = createApp({ MODEL_NAME: 'mock-for-ordinary-browser-tests' }, { tasks, accessToken: token }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address'); backend = `http://127.0.0.1:${address.port}`;
  const extension = resolve('apps/extension/dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ...(process.env.CLICKFLOW_TEST_CHROMIUM ? { executablePath: process.env.CLICKFLOW_TEST_CHROMIUM } : {}),
    viewport: { width: 1280, height: 1100 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  await context.route('http://127.0.0.1:3001/api/**', async (route) => {
    const original = new URL(route.request().url());
    const response = await route.fetch({ url: `${backend}${original.pathname}${original.search}` });
    await route.fulfill({ response });
  });
});
test.afterAll(async () => {
  await context?.close();
  server?.closeIdleConnections(); if (server) await new Promise<void>((done) => server.close(() => done()));
  if (profile) await rm(profile, { recursive: true, force: true }); if (data) await rm(data, { recursive: true, force: true });
});
test.beforeEach(async () => {
  mode = 'focus'; modelCalls = 0; recoveryCalls = 0; recoveryReturned = false;
  page = await context.newPage(); await page.goto('http://127.0.0.1:4173/fixtures/browser.html');
  panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.evaluate(async (value) => { await chrome.storage.local.remove(['clickflowTaskId', 'clickflowPreparedTask', 'clickflowExecutionJournal', 'clickflowTaskCheckpoint', 'clickflowTaskDraft']); await chrome.storage.local.set({ clickflowAccessToken: value }); }, token);
  await panel.reload(); await page.bringToFront();
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' }));
});
test.afterEach(async () => {
  const current = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string | undefined);
  if (current) await tasks.stop(current);
  await panel?.close(); await page?.close();
});
async function generate() {
  await panel.getByLabel('What would you like to do?').fill('Focus the Search field on this test page.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('ready');
  await expect(panel.locator('.plan-steps li')).toHaveCount(2);
}
test('reviews the full plan, dispatches one real click, verifies and preserves pending steps', async () => {
  await generate();
  await expect(page.locator('#fixture-search')).not.toBeFocused();
  await expect(panel.locator('.plan-steps .status-pending')).toHaveCount(2);
  const ids = await panel.locator('.plan-steps').innerText(); expect(ids).toContain('Assess goal completion');
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.task-state')).toContainText('paused');
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(panel.locator('.plan-steps .status-pending')).toHaveCount(1);
  await expect(page.locator('#fixture-search')).toBeFocused();
  await expect(panel.locator('.task-state')).toContainText('plan v3');
  await expect(panel.locator('.task-state .action-outcome')).toContainText('passed'); expect(modelCalls).toBe(1);
  await panel.reload(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1); expect(modelCalls).toBe(1);
});
test('types a model-planned value into the real controlled React fixture and verifies it', async () => {
  mode = 'type'; await generate(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(page.locator('#fixture-controlled-output')).toHaveText('Controlled value: phase four'); expect(modelCalls).toBe(1);
});
test('a real dispatched click with no effect fails verification and pauses without retry', async () => {
  mode = 'fail'; await generate(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-failed')).toHaveCount(1);
  await expect(panel.locator('.task-state')).toContainText('paused'); expect(modelCalls).toBe(1);
});
test('Stop during planning persists cancellation and does not accept the late plan', async () => {
  mode = 'slow'; await panel.getByLabel('What would you like to do?').fill('Focus Search');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('planning');
  await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('cancelled'); await expect(panel.locator('.plan-steps li')).toHaveCount(0);
});
test('plan review remains usable at narrow sizes with keyboard and reduced motion', async () => {
  await generate();
  for (const width of [320, 390, 1280]) {
    await panel.setViewportSize({ width, height: 1000 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  const start = panel.getByRole('button', { name: 'Start next step' }); await start.focus(); await expect(start).toBeFocused();
  await panel.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: 'Stop task', exact: true })).toBeFocused();
  await panel.setViewportSize({ width: 390, height: 1000 });
  await panel.screenshot({ path: 'test-results/clickflow-phase-4-panel.png', fullPage: true });
});

test('optional live model plans an actual fixture task and a real browser action is verified', async () => {
  test.skip(process.env.RUN_LIVE_AGENT !== '1', 'Explicit opt-in required for the live model.');
  test.setTimeout(200_000);
  mode = 'live';
  await panel.getByLabel('What would you like to do?').fill('Click the Search field so it is focused. Do not type, navigate, or scroll.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('ready', { timeout: 150_000 });
  const id = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string);
  const original = await tasks.get(id);
  for (let count = 0; count < 3; count++) {
    await panel.getByRole('button', { name: 'Start next step' }).click();
    await expect(panel.locator('.task-state')).toContainText('paused');
    const checkpoint = await tasks.get(id);
    expect(checkpoint.actionHistory.at(-1)?.verification?.status).toBe('passed');
    if (await page.locator('#fixture-search').evaluate((element) => element === document.activeElement)) break;
  }
  await expect(page.locator('#fixture-search')).toBeFocused();
  const updated = await tasks.get(id);
  expect(updated.plan?.steps.map((step) => step.id)).toEqual(original.plan?.steps.map((step) => step.id));
  expect(updated.plan?.steps.some((step) => step.status === 'completed')).toBe(true);
  expect(modelCalls).toBe(1);
  console.log(`Live Phase 4: ${original.plan?.steps.length} planned steps, ${updated.actionHistory.length} verified browser action(s), stable plan IDs preserved.`);
  await panel.setViewportSize({ width: 390, height: 1000 });
  await panel.screenshot({ path: 'test-results/clickflow-phase-4-live.png', fullPage: true });
});

test('replaying a full task envelope returns its saved outcome without a second real click', async () => {
  mode = 'reveal'; await generate(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(page.locator('#fixture-count')).toHaveText('1');
  const replay = await panel.evaluate(async () => {
    const saved = (await chrome.storage.local.get('clickflowPreparedTask')).clickflowPreparedTask as Record<string, unknown>;
    const { actionId: _actionId, response: _response, ...command } = saved;
    void _actionId; void _response;
    return chrome.runtime.sendMessage(command);
  });
  expect(replay.ok).toBe(true); await expect(page.locator('#fixture-count')).toHaveText('1');
});

test('navigates and extracts through the backend, preserves the plan, and requests finish without another model call', async () => {
  mode = 'navigation-extraction';
  await panel.getByLabel('What would you like to do?').fill('Open fixture details and extract the product information.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.plan-steps li')).toHaveCount(3);
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(page).toHaveURL('http://127.0.0.1:4173/fixtures/details.html');
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(2);
  await expect(panel.locator('.action-outcome > pre')).toHaveText('Aster laptop: 16 GB RAM, 512 GB storage.');
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-blocked')).toHaveCount(1);
  await expect(panel.locator('.task-state')).toContainText('paused');
  expect(modelCalls).toBe(1);
  await panel.setViewportSize({ width: 390, height: 1100 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/clickflow-phase-5.png', fullPage: true });
});
test('an unresolved persistent dispatch journal blocks a new task envelope before DOM dispatch', async () => {
  mode = 'reveal'; await generate();
  const stored = await panel.evaluate(async () => ({ id: (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string,
    state: await chrome.runtime.sendMessage({ kind: 'get_fixture_state' }) }));
  let task = await tasks.get(stored.id);
  task = await tasks.start(task.id, task.revision, stored.state.session.observation);
  task = await tasks.authorize(task.id, task.revision, 'new-action');
  const response = await panel.evaluate(async (command) => {
    await chrome.storage.local.set({ clickflowPreparedTask: { actionId: 'uncertain-old-action', response: null } });
    return chrome.runtime.sendMessage(command);
  }, { kind: 'execute_task_action', sessionId: stored.state.session.id, ...task.pendingAction! });
  expect(response.ok).toBe(false); await expect(page.locator('#fixture-count')).toHaveText('0');
  expect((await tasks.get(task.id)).pendingAction?.authorization.actionId).toBe('new-action');
});

async function recoveryFixture() {
  await panel.getByLabel('What would you like to do?').fill('Reveal the result, then focus Search.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click();
  await expect(panel.locator('.plan-steps li')).toHaveCount(3);
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Start next step' }).click();
}
test('a missing target triggers a bounded existing-plan patch and a verified retry', async () => {
  mode = 'recover'; await recoveryFixture();
  await expect(panel.locator('.task-state')).toContainText('ready');
  await expect(panel.locator('.task-state')).toContainText('The old Search name is missing');
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(page.locator('#fixture-count')).toHaveText('1');
  const id = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string);
  const patched = await tasks.get(id);
  expect(patched.plan?.steps.map((step) => step.id)).toEqual(['step-1', 'recover-step', 'step-2']);
  expect(patched.retryCounts['recover-step']).toBe(1);
  await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(2);
  await expect(page.locator('#fixture-search')).toBeFocused();
  const retried = await tasks.get(id); expect(retried.retryCounts['recover-step']).toBe(2);
  expect(retried.modelCallCount).toBe(2); expect(recoveryCalls).toBe(1); expect(modelCalls).toBe(1);
  await panel.setViewportSize({ width: 390, height: 1100 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/clickflow-phase-6.png', fullPage: true });
});
test('Stop during recovery ignores the returned patch and keeps completed work', async () => {
  mode = 'recover-slow'; await recoveryFixture();
  await expect(panel.locator('.task-state')).toContainText('recovering');
  await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(panel.locator('.task-state')).toContainText('cancelled');
  await expect.poll(() => recoveryReturned).toBe(true);
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await expect(panel.locator('.plan-steps .status-failed')).toHaveCount(1);
  await expect(page.locator('#fixture-count')).toHaveText('1');
});
