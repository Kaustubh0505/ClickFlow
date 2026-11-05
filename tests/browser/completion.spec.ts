import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { initialPlanSchema, type PlanStep, type CompletionProposal } from '@clickflow/shared';
import { createApp } from '../../apps/backend/src/app.js';
import { TaskService } from '../../apps/backend/src/execution/task-service.js';
import { AtomicFileTaskStore } from '../../apps/backend/src/state/atomic-file-task-store.js';
import { CompletionAssessor } from '../../apps/backend/src/agent/completion.js';
import { makePlan } from '../fixtures.js';

let context: BrowserContext; let panel: Page; let page: Page; let server: Server; let tasks: TaskService;
let profile: string; let directory: string; let backend: string; let extensionId: string; let id: string | null;
let mode = 'research'; let assessmentCalls = 0; let returned = false;
const token = '9'.repeat(64); const root = 'http://127.0.0.1:4173/fixtures/browser.html'; const details = 'http://127.0.0.1:4173/fixtures/details.html';
const request = 'Read the laptop specifications on the details page and return to search.';
function planned(goal: string) {
  const plan = makePlan(); plan.goal = goal;
  if (mode === 'typed') {
    const target = { strategy: 'role' as const, role: 'searchbox' as const, name: 'Search', exact: true };
    plan.steps[0]!.action = { type: 'type', target, text: 'laptops', timeoutMs: 1000 };
    plan.steps[0]!.verification = { type: 'input_value_equals', target, value: 'laptops' };
    plan.goalCriteria = [{ id: 'typed-goal', description: 'Search contains laptops', verification: plan.steps[0]!.verification }];
  } else {
    const step = plan.steps[0]!;
    const work = (id: string, description: string, action: PlanStep['action'], verification: PlanStep['verification'], dependencies: string[]) => ({ ...step, id, logicalStepId: id, description, action, verification, dependencies });
    plan.steps = [
      work('navigate-details', 'Open the product details', { type: 'navigate', url: details, timeoutMs: 2000 }, { type: 'url_matches', url: details, match: 'exact' }, []),
      work('extract-product', 'Record the laptop specifications', { type: 'extract_text', target: { strategy: 'text', text: 'Aster laptop: 16 GB RAM, 512 GB storage.', exact: false }, outputKey: 'product', maxCharacters: 4000, timeoutMs: 1000 }, { type: 'extracted_data_matches_schema', outputKey: 'product', schemaId: 'text-v1' }, ['navigate-details']),
      work('return-search', 'Return to the search page', { type: 'navigate', url: root, timeoutMs: 2000 }, { type: 'url_matches', url: root, match: 'exact' }, ['extract-product']),
      { ...plan.steps[1]!, dependencies: ['return-search'] },
    ];
    plan.goalCriteria = [{ id: 'specifications', description: 'The laptop specifications were collected from their source.' },
      mode === 'partial' || mode === 'long' ? { id: 'comparison', description: 'Three laptops and their prices were compared.' } : { id: 'returned', description: 'The search page is open.', verification: { type: 'url_matches', url: root, match: 'exact' } }];
  }
  return initialPlanSchema.parse(plan);
}
test.beforeEach(async () => {
  mode = 'research'; assessmentCalls = 0; returned = false; id = null;
  directory = await mkdtemp(join(tmpdir(), 'clickflow-results-data-')); profile = await mkdtemp(join(tmpdir(), 'clickflow-results-profile-'));
  const store = new AtomicFileTaskStore(directory); await store.initialize();
  const completion = new CompletionAssessor({ json: async (_system, user) => {
    assessmentCalls++;
    const input = JSON.parse(user) as { existingPlan: ReturnType<typeof makePlan>; evidenceCatalog: Array<{ evidence: { id: string }; criterionId?: string; content: string }> };
    if (mode === 'slow') await new Promise((done) => setTimeout(done, 1500));
    returned = true;
    const output: CompletionProposal = { status: mode === 'partial' || mode === 'long' ? 'partial' : 'completed', criteria: input.existingPlan.goalCriteria.map((criterion) => {
      if (criterion.id === 'comparison') return { criterionId: criterion.id, status: 'unknown', evidenceIds: [], citations: [] };
      const source = input.evidenceCatalog.find((entry) => criterion.verification ? entry.criterionId === criterion.id : entry.content.includes('Extracted text:'))!;
      const quote = mode === 'invalid' ? 'The website has purchased three laptops.' : source.content.includes('Extracted text:') ? source.content.split('Extracted text: ')[1]! : source.content;
      return { criterionId: criterion.id, status: 'met', evidenceIds: [source.evidence.id], citations: [{ evidenceId: source.evidence.id, quote }] };
    }) };
    return JSON.stringify(output);
  } });
  tasks = new TaskService(store, { generate: async (input) => planned((input as { originalRequest: string }).originalRequest) }, undefined, completion);
  server = createApp({ MODEL_NAME: 'mock-completion-model', MODEL_BASE_URL: 'https://example.com/api/v1' }, { tasks, accessToken: token }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing backend'); backend = `http://127.0.0.1:${address.port}`;
  const extension = resolve('apps/extension/dist'); context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ...(process.env.CLICKFLOW_TEST_CHROMIUM ? { executablePath: process.env.CLICKFLOW_TEST_CHROMIUM } : {}), viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  await context.route('http://127.0.0.1:3001/api/**', async (route) => { const url = new URL(route.request().url()); const response = await route.fetch({ url: `${backend}${url.pathname}${url.search}` }); await route.fulfill({ response }); });
  page = await context.newPage(); await page.goto(root); panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.evaluate(async (value) => { await chrome.storage.local.set({ clickflowAccessToken: value }); }, token);
  await panel.reload(); await page.bringToFront(); expect((await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'bind_fixture' }))).ok).toBe(true);
});
test.afterEach(async () => {
  if (id) await tasks.stop(id); await context?.close(); server.closeIdleConnections(); await new Promise<void>((done) => server.close(() => done()));
  await rm(directory, { recursive: true, force: true }); await rm(profile, { recursive: true, force: true });
});
async function generate() {
  await panel.getByLabel('What would you like to do?').fill(mode === 'typed' ? 'Set the Search field to laptops.' : request);
  await panel.getByRole('button', { name: 'Generate plan', exact: true }).click(); await expect(panel.locator('.task-state')).toContainText('ready');
  id = await panel.evaluate(async () => (await chrome.storage.local.get('clickflowTaskId')).clickflowTaskId as string);
}
async function doWork() {
  await generate();
  for (let index = 0; index < 3; index++) {
    await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(index + 1);
    if (index === 0 && mode === 'long') await page.locator('#fixture-extract').evaluate((element) => { element.textContent += ' The display and storage specifications were collected from this local product page.'.repeat(24); });
  }
  await expect(page).toHaveURL(root);
}

test('finishes actual multipage research using earlier extraction sources and persisted criterion citations', async () => {
  await doWork(); const ids = (await tasks.get(id!)).plan!.steps.map((step) => step.id);
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.getByRole('heading', { name: 'Completed with evidence' })).toBeVisible();
  const result = await tasks.get(id!); expect(result.status).toBe('completed'); expect(result.modelCallCount).toBe(2); expect(assessmentCalls).toBe(1);
  expect(result.plan!.steps.map((step) => step.id)).toEqual(ids); expect(result.result!.evidence.some((entry) => entry.sourceUrl === details)).toBe(true);
  expect(result.currentContext!.url).toBe(root); await expect(panel.getByRole('progressbar', { name: 'Verified plan progress' })).toHaveAttribute('value', '4');
  await panel.locator('.task-result').getByText('Assessment sources (2)', { exact: true }).click();
  await expect(panel.locator('.task-result a', { hasText: details })).toBeVisible();
  await panel.reload(); await expect(panel.getByRole('heading', { name: 'Completed with evidence' })).toBeVisible(); expect(assessmentCalls).toBe(1);
});
test('shows missing information as partial and retains the blocked finish step', async () => {
  mode = 'partial'; await doWork(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.getByRole('heading', { name: 'Partial result' })).toBeVisible(); await expect(panel.locator('.criterion-list')).toContainText('Not established');
  expect((await tasks.get(id!)).status).toBe('paused'); await expect(panel.locator('.plan-steps .status-blocked')).toHaveCount(1);
});
test('rejects a fabricated model completion quotation and retains actual browser evidence', async () => {
  mode = 'invalid'; await doWork(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.locator('.task-state')).toContainText('quotation is not present');
  expect((await tasks.get(id!)).result).toBeNull(); await expect(panel.getByRole('heading', { name: 'Completed with evidence' })).toHaveCount(0);
  await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(3);
});
test('Stop during final assessment ignores the late reply and leaves verified work inspectable', async () => {
  mode = 'slow'; await doWork(); await panel.getByRole('button', { name: 'Start next step' }).click();
  await expect(panel.getByRole('heading', { name: 'Assessing results' })).toBeVisible(); await panel.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Task cancelled' })).toBeVisible(); await expect.poll(() => returned).toBe(true);
  expect((await tasks.get(id!)).result).toBeNull(); expect((await tasks.get(id!)).status).toBe('cancelled');
});
test('fresh typed checks complete without another model call or extra input events', async () => {
  mode = 'typed'; await generate(); await page.locator('#fixture-search').evaluate((element) => element.addEventListener('input', () => element.setAttribute('data-input-events', String(Number(element.getAttribute('data-input-events') ?? 0) + 1))));
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.getByRole('heading', { name: 'Completed with evidence' })).toBeVisible();
  expect(assessmentCalls).toBe(0); expect((await tasks.get(id!)).modelCallCount).toBe(1); await expect(page.locator('#fixture-search')).toHaveAttribute('data-input-events', '1');
});
test('manually changed input produces blocked results rather than relying on the earlier successful action', async () => {
  mode = 'typed'; await generate(); await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.locator('.plan-steps .status-completed')).toHaveCount(1);
  await page.locator('#fixture-search').fill('changed after verification'); await panel.getByRole('button', { name: 'Assess results', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'More evidence needed' })).toBeVisible(); expect(assessmentCalls).toBe(0); expect((await tasks.get(id!)).status).toBe('paused');
  await expect(page.locator('#fixture-search')).toHaveValue('changed after verification');
});
test('settings persist lowered limits and evidence preference while the current task retains its limits', async () => {
  await panel.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(panel.locator('#settings-summary')).toBeFocused();
  await expect(panel.locator('#agent-settings')).toContainText('mock-completion-model'); await expect(panel.locator('#agent-settings')).toContainText('https://example.com/api/v1');
  await panel.getByLabel('Maximum actions', { exact: true }).fill('5'); await panel.getByLabel('Expand activity evidence by default').check();
  await generate(); expect((await tasks.get(id!)).limits.maxActions).toBe(5);
  await panel.getByLabel('Maximum actions', { exact: true }).fill('4'); expect((await tasks.get(id!)).limits.maxActions).toBe(5);
  await panel.reload(); await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel.getByLabel('Maximum actions', { exact: true })).toHaveValue('4'); await expect(panel.getByLabel('Expand activity evidence by default')).toBeChecked();
});
test('results, sources and settings remain usable with long text, narrow widths, keyboard and reduced motion', async () => {
  mode = 'long'; await doWork(); await panel.getByRole('button', { name: 'Start next step' }).click(); await expect(panel.getByRole('heading', { name: 'Partial result' })).toBeVisible();
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) { await panel.setViewportSize({ width, height: 1000 }); expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await panel.getByRole('button', { name: 'Settings', exact: true }).focus(); await panel.keyboard.press('Enter'); await expect(panel.locator('#settings-summary')).toBeFocused();
  const outline = await panel.locator('#settings-summary').evaluate((element) => getComputedStyle(element).outlineStyle); expect(outline).not.toBe('none');
  await panel.keyboard.press('Tab'); await expect(panel.getByLabel('Maximum actions', { exact: true })).toBeFocused();
  await panel.locator('#settings-summary').click(); await panel.setViewportSize({ width: 390, height: 1000 });
  await panel.locator('.task-result').getByText('Read recorded excerpt', { exact: true }).click();
  await expect(panel.locator('.task-result blockquote')).toContainText('The display and storage specifications');
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator('.task-result').getByText('Read recorded excerpt', { exact: true }).click();
  await panel.locator('.task-result').scrollIntoViewIfNeeded(); await panel.screenshot({ path: 'test-results/clickflow-phase-9-results.png' });
});
