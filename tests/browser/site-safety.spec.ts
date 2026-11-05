import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../../apps/backend/src/app.js';
import { TaskService } from '../../apps/backend/src/execution/task-service.js';
import { PairingStore } from '../../apps/backend/src/execution/pairing.js';
import { AtomicFileTaskStore } from '../../apps/backend/src/state/atomic-file-task-store.js';
import { makePlan } from '../fixtures.js';

let context: BrowserContext; let page: Page; let panel: Page; let profile: string; let data: string;
let tasks: TaskService; let server: Server; let extensionId: string; let backend: string;
const setup = 'e'.repeat(64); const origin = 'http://127.0.0.1:4173';
let mode = 'send';
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'clickflow-site-profile-')); data = await mkdtemp(join(tmpdir(), 'clickflow-site-data-'));
  const store = new AtomicFileTaskStore(data); await store.initialize(); const pairing = new PairingStore(data, setup); await pairing.initialize();
  tasks = new TaskService(store, { generate: async (input) => {
    const plan = makePlan(); plan.goal = (input as { originalRequest: string }).originalRequest;
    plan.steps[0]!.description = 'Activate the inert message control after review';
    plan.steps[0]!.action = { type: 'click', target: { strategy: 'role', role: 'button', name: 'Send message', exact: true }, timeoutMs: 1000 };
    plan.steps[0]!.verification = { type: 'text_present', text: 'Test action verified' };
    if (mode === 'type') {
      const target = { strategy: 'role' as const, role: 'searchbox' as const, name: 'Search', exact: true };
      plan.steps[0]!.action = { type: 'type', target, text: 'laptops', timeoutMs: 1000 }; plan.steps[0]!.verification = { type: 'input_value_equals', target, value: 'laptops' };
    }
    // Deliberately low: browser policy must detect consequences independently of the model.
    return plan;
  } });
  server = createApp({ MODEL_NAME: 'mock-safety-tests' }, { tasks, accessToken: setup, pairing }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); backend = `http://127.0.0.1:${address.port}`;
  const extension = resolve('apps/extension/dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ...(process.env.CLICKFLOW_TEST_CHROMIUM ? { executablePath: process.env.CLICKFLOW_TEST_CHROMIUM } : {}),
    viewport: { width: 1280, height: 1100 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  await context.route('http://127.0.0.1:3001/api/**', async (route) => {
    const url = new URL(route.request().url()); const response = await route.fetch({ url: `${backend}${url.pathname}${url.search}` }); await route.fulfill({ response });
  });
});
test.afterAll(async () => {
  await context?.close(); server?.closeIdleConnections(); if (server) await new Promise<void>((done) => server.close(() => done()));
  if (profile) await rm(profile, { recursive: true, force: true }); if (data) await rm(data, { recursive: true, force: true });
});
test.beforeEach(async () => {
  mode = 'send';
  page = await context.newPage(); await page.goto(`${origin}/sites/safety.html`);
  panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.evaluate(async () => { await chrome.storage.local.remove(['clickflowAccessToken', 'clickflowTaskId', 'clickflowPreparedTask', 'clickflowOrigins', 'clickflowExecutionJournal', 'clickflowTaskCheckpoint', 'clickflowTaskDraft']); });
  await panel.reload(); await page.bringToFront();
  await panel.getByLabel('Local connection token').fill(setup); await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Generate plan', exact: true })).toBeDisabled(); // No task text yet.
  await expect.poll(() => panel.evaluate(async () => (await chrome.storage.local.get('clickflowAccessToken')).clickflowAccessToken as string | undefined)).toMatch(/^[a-f0-9]{64}$/);
});
test.afterEach(async () => {
  const id = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string | undefined);
  if (id) await tasks.stop(id); await panel?.close(); await page?.close();
});
async function allowAndBind() {
  await panel.getByRole('button', { name: 'Refresh site', exact: true }).click();
  await expect(panel.locator('.site-origin').first()).toHaveText(origin);
  await panel.getByRole('button', { name: 'Allow current site', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Site access allowed' })).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: 'Page bound — ready to generate a plan' })).toBeVisible();
  const bound = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' })); expect(bound.ok).toBe(true); return bound.session;
}
async function reviewTask() {
  await allowAndBind(); await panel.getByLabel('What would you like to do?').fill('Test the inert message control after my confirmation.');
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click(); await expect(panel.locator('.task-state')).toContainText('ready');
  await panel.getByRole('button', { name: 'Start next step', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Action confirmation' })).toBeVisible(); await expect(page.locator('#count')).toHaveText('0');
}
test('pairs through UI, denies ungranted pages, reviews an exact action and executes once after approval', async () => {
  const denied = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' })); expect(denied.ok).toBe(false); expect(denied.error.code).toBe('PERMISSION_REQUIRED');
  await reviewTask();
  for (const width of [320, 390, 768, 1440]) { await panel.setViewportSize({ width, height: 1000 }); expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await panel.emulateMedia({ reducedMotion: 'reduce' }); await panel.setViewportSize({ width: 390, height: 1000 });
  const approve = panel.getByRole('button', { name: 'Approve this action', exact: true }); await approve.focus(); await expect(approve).toBeFocused(); await panel.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: 'Decline and stop' })).toBeFocused();
  await panel.screenshot({ path: 'test-results/clickflow-phase-7-confirmation.png', fullPage: true });
  await approve.click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1); await expect(page.locator('#count')).toHaveText('1');
  const replay = await panel.evaluate(async () => { const stored = (await chrome.storage.local.get('clickflowPreparedTask')).clickflowPreparedTask as Record<string, unknown>; const { actionId: _id, response: _response, ...command } = stored; void _id; void _response; return chrome.runtime.sendMessage(command); });
  expect(replay.ok).toBe(true); await expect(page.locator('#count')).toHaveText('1');
});
test('declining approval cancels without sending', async () => {
  await reviewTask(); await panel.getByRole('button', { name: 'Decline and stop' }).click(); await expect(panel.locator('.task-state')).toContainText('cancelled'); await expect(page.locator('#count')).toHaveText('0');
});
test('hidden tab metadata can be supplied explicitly and Allow binds the matching page automatically', async () => {
  await panel.evaluate(() => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) => (await original(query)).map(({ url: _url, pendingUrl: _pending, ...tab }) => { void _url; void _pending; return tab; })) as typeof chrome.tabs.query;
  });
  await panel.getByRole('button', { name: 'Refresh site', exact: true }).click();
  await panel.getByLabel('Site address', { exact: true }).fill(`${origin}/sites/safety.html`);
  await panel.getByRole('button', { name: 'Allow current site', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Page bound — ready to generate a plan' })).toBeVisible();
  const result = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'get_fixture_state' }));
  expect(result.session.stopped).toBe(false); expect(result.session.observation.url).toBe(`${origin}/sites/safety.html`);
});
test('a normal-site typing action is reviewed and deterministically verified', async () => {
  mode = 'type'; await reviewTask();
  await expect(page.locator('#site-search')).toHaveValue('');
  await panel.getByRole('button', { name: 'Approve this action', exact: true }).click();
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1); await expect(page.locator('#site-search')).toHaveValue('laptops');
});
test('a different origin is refused before navigation even with Chrome loopback host access', async () => {
  const session = await allowAndBind(); const url = 'http://127.0.0.1:65530/sites/safety.html';
  const result = await panel.evaluate((command) => chrome.runtime.sendMessage(command), { kind: 'execute_fixture', sessionId: session.id, actionId: crypto.randomUUID(),
    action: { type: 'navigate', url, timeoutMs: 500 }, verification: { type: 'url_matches', url, match: 'exact' } });
  expect(result.ok).toBe(false); expect(result.error.code).toBe('PERMISSION_REQUIRED'); await expect(page).toHaveURL(`${origin}/sites/safety.html`);
});
test('a form value changed without DOM events invalidates approval before dispatch', async () => {
  await reviewTask(); await page.locator('#draft').evaluate((element) => { (element as HTMLInputElement).value = 'Changed without an event'; });
  await panel.getByRole('button', { name: 'Approve this action', exact: true }).click(); await expect(panel.locator('.plan-steps .status-failed')).toHaveCount(1); await expect(page.locator('#count')).toHaveText('0');
  await expect(panel.locator('.task-state')).toContainText('not_dispatched');
});
test('revoking site access while awaiting approval blocks dispatch', async () => {
  await reviewTask(); await panel.getByRole('button', { name: 'Revoke site access', exact: true }).click();
  await panel.getByRole('button', { name: 'Approve this action', exact: true }).click(); await expect(page.locator('#count')).toHaveText('0');
  await expect(panel.locator('.tool-error').first()).toBeVisible();
  const denied = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' })); expect(denied.ok).toBe(false);
});
test('private fields and an unapproved button/key cannot dispatch through manual tools', async () => {
  const session = await allowAndBind();
  for (const action of [{ type: 'type', target: { strategy: 'selector', selector: '#password' }, text: 'blocked', timeoutMs: 300 },
    { type: 'click', target: { strategy: 'selector', selector: '#send' }, timeoutMs: 300 },
    { type: 'press_key', key: 'Space', target: { strategy: 'selector', selector: '#send' }, timeoutMs: 300 }]) {
    const result = await panel.evaluate((command) => chrome.runtime.sendMessage(command), { kind: 'execute_fixture', sessionId: session.id, actionId: crypto.randomUUID(), action, verification: { type: 'text_present', text: 'Test action verified' } });
    expect(result.session.lastResult.dispatchStatus).toBe('not_dispatched'); expect(result.session.lastResult.error.code).toBe('POLICY_BLOCKED');
  }
  await expect(page.locator('#count')).toHaveText('0'); await expect(page.locator('#password')).toHaveValue('private-test-password');
  const observed = await panel.evaluate((sessionId) => chrome.runtime.sendMessage({ kind: 'observe_fixture', sessionId, screenshot: true }), session.id);
  expect(observed.screenshotDataUrl).toBeUndefined(); expect(JSON.stringify(observed.session.observation)).not.toContain('private-test-password');
});
test('changed action parameters cannot reuse a confirmation and disconnect revokes backend access', async () => {
  await reviewTask();
  const id = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string); const current = await tasks.get(id);
  const stored = current.confirmations[0]!.challenge;
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'get_fixture_state' }));
  const altered = await panel.evaluate((command) => chrome.runtime.sendMessage(command), { kind: 'execute_task_action', sessionId: state.session.id, ...current.pendingAction!, authorization: { ...current.pendingAction!.authorization, action: { type: 'click', target: { strategy: 'selector', selector: '#private-submit' }, timeoutMs: 1000 } }, approval: { id: stored.id, fingerprint: stored.fingerprint } });
  expect(altered.ok).toBe(false); expect(altered.error.code).toBe('INTERRUPTED'); await expect(page.locator('#count')).toHaveText('0');
  await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  const token = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowAccessToken')).clickflowAccessToken as string);
  await panel.getByText('Local backend connection', { exact: true }).click(); await panel.getByRole('button', { name: 'Disconnect backend', exact: true }).click();
  await expect.poll(() => panel.evaluate(async () => (await chrome.storage.local.get('clickflowAccessToken')).clickflowAccessToken)).toBeUndefined();
  expect((await fetch(`${backend}/api/tasks/${id}`, { headers: { Authorization: `Bearer ${token}`, 'X-ClickFlow-Extension': `chrome-extension://${extensionId}` } })).status).toBe(401);
});
