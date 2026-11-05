import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { browserToolResponseSchema } from '@clickflow/shared';
import type { Action, BrowserToolCommand, BrowserToolResponse, FixtureSession, VerificationCondition } from '@clickflow/shared';

let context: BrowserContext;
let extensionId: string;
let panel: Page;
let page: Page;
let profile: string;
let session: FixtureSession;

const selector = (value: string) => ({ strategy: 'selector' as const, selector: value });
async function command(input: BrowserToolCommand): Promise<BrowserToolResponse> {
  const response: unknown = await panel.evaluate((request) => chrome.runtime.sendMessage(request), input);
  const parsed = browserToolResponseSchema.parse(response);
  if (parsed.session) session = parsed.session;
  return parsed;
}
async function observe(screenshot = false) {
  const response = await command({ kind: 'observe_fixture', sessionId: session.id, screenshot });
  expect(response.ok, JSON.stringify(response.ok ? null : response.error)).toBe(true);
  return response;
}
async function act(action: Action, verification: VerificationCondition, actionId = crypto.randomUUID()) {
  return command({ kind: 'execute_fixture', sessionId: session.id, actionId, action, verification });
}
const focused: VerificationCondition = { type: 'element_focused', target: selector('#fixture-search') };

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'clickflow-browser-'));
  const extension = resolve('apps/extension/dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ...(process.env.CLICKFLOW_TEST_CHROMIUM ? { executablePath: process.env.CLICKFLOW_TEST_CHROMIUM } : {}),
    viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
});
test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
test.beforeEach(async () => {
  page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/fixtures/browser.html');
  await expect(page.getByRole('heading', { name: 'Safe controls' })).toBeVisible();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  const response = await command({ kind: 'bind_fixture' });
  expect(response.ok, JSON.stringify(response.ok ? null : response.error)).toBe(true);
  expect(response.session).not.toBeNull();
});
test.afterEach(async () => { await panel?.close(); await page?.close(); });

test('observes the actual fixture with Chrome document identity and private values excluded', async () => {
  const observation = session.observation;
  expect(observation.documentId).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(observation.elements.some((element) => element.name === 'Search')).toBe(true);
  expect(observation.elements.some((element) => element.name === 'Controlled query')).toBe(true);
  const serialized = JSON.stringify(observation);
  for (const secret of ['fixture-password-do-not-collect', 'fixture-hidden-token-do-not-collect', 'sk-fixtureDoNotCollect123456789', 'private-fixture-note-do-not-collect', 'hidden-unrelated-fixture-content']) expect(serialized).not.toContain(secret);
  expect(observation.screenshot.status).toBe('omitted');
});

test('clicks a safe target and verifies actual focus with evidence', async () => {
  const response = await act({ type: 'click', target: { strategy: 'role', role: 'searchbox', name: 'Search', exact: true }, timeoutMs: 1_000 }, focused);
  expect(response.ok).toBe(true);
  expect(session.lastResult?.dispatchStatus).toBe('dispatched');
  expect(session.lastResult?.verification?.status).toBe('passed');
  expect(session.lastResult?.verification?.evidence.length).toBeGreaterThan(0);
  await expect(page.locator('#fixture-search')).toBeFocused();
});

test('types into a native input and verifies the expected value', async () => {
  await act({ type: 'type', target: { strategy: 'label', label: 'Search', exact: true }, text: 'native laptop query', timeoutMs: 1_000 }, { type: 'input_value_equals', target: selector('#fixture-search'), value: 'native laptop query' });
  expect(session.lastResult?.verification?.status).toBe('passed');
  await expect(page.locator('#fixture-search')).toHaveValue('native laptop query');
});

test('updates a controlled React input and verifies the rendered application state', async () => {
  await act({ type: 'type', target: selector('#fixture-controlled'), text: 'controlled laptop query', timeoutMs: 1_000 }, { type: 'text_present', target: selector('#fixture-controlled-output'), text: 'Controlled value: controlled laptop query' });
  expect(session.lastResult?.verification?.status).toBe('passed');
  await expect(page.locator('#fixture-controlled-output')).toHaveText('Controlled value: controlled laptop query');
});

test('rejects ambiguous accessible-name matches before dispatch', async () => {
  await act({ type: 'click', target: { strategy: 'role', role: 'button', name: 'Duplicate target', exact: true }, timeoutMs: 1_000 }, focused);
  expect(session.lastResult?.dispatchStatus).toBe('not_dispatched');
  expect(session.lastResult?.error?.code).toBe('TARGET_AMBIGUOUS');
});

test('rejects missing, disabled, and hidden targets', async () => {
  for (const [id, code] of [['#does-not-exist', 'TARGET_NOT_FOUND'], ['#fixture-disabled', 'TARGET_DISABLED'], ['#fixture-hidden', 'TARGET_NOT_FOUND']]) {
    await act({ type: 'click', target: selector(id!), timeoutMs: 300 }, focused);
    expect(session.lastResult?.error?.code).toBe(code);
    expect(session.lastResult?.dispatchStatus).toBe('not_dispatched');
  }
});

test('does not treat a dispatched click as verified success', async () => {
  await act({ type: 'click', target: selector('#fixture-no-change'), timeoutMs: 150 }, { type: 'element_visible', target: selector('#fixture-result') });
  expect(session.lastResult?.dispatchStatus).toBe('dispatched');
  expect(session.lastResult?.verification?.status).toBe('failed');
  expect(session.lastResult?.error?.code).toBe('VERIFICATION_TIMEOUT');
});

test('waits for the relevant delayed DOM change', async () => {
  await act({ type: 'click', target: selector('#fixture-delay'), timeoutMs: 3_000 }, { type: 'element_visible', target: selector('#fixture-delayed-result') });
  expect(session.lastResult?.verification?.status).toBe('passed');
  await expect(page.locator('#fixture-delayed-result')).toBeVisible();
});

test('stops an in-flight wait and refuses subsequent actions', async () => {
  const running = act({ type: 'click', target: selector('#fixture-delay'), timeoutMs: 5_000 }, { type: 'element_visible', target: selector('#fixture-delayed-result') });
  await expect.poll(async () => (await command({ kind: 'get_fixture_state' })).session?.runningActionId).not.toBeNull();
  const stopped = await command({ kind: 'stop_fixture', sessionId: session.id });
  expect(stopped.session?.stopped).toBe(true);
  await running;
  expect(session.stopped).toBe(true);
  expect(session.lastResult?.error?.code).toBe('CANCELLED');
  const next = await act({ type: 'click', target: selector('#fixture-reveal'), timeoutMs: 300 }, focused);
  expect(next.ok).toBe(false);
  if (!next.ok) expect(next.error.code).toBe('STOPPED');
  await expect(page.locator('#fixture-result')).toBeHidden();
});

test('blocks competing execution without losing the original in-flight action', async () => {
  const running = act({ type: 'click', target: selector('#fixture-delay'), timeoutMs: 3_000 }, { type: 'element_visible', target: selector('#fixture-delayed-result') });
  await expect.poll(async () => (await command({ kind: 'get_fixture_state' })).session?.runningActionId).not.toBeNull();
  const competing = await act({ type: 'click', target: selector('#fixture-reveal'), timeoutMs: 300 }, focused);
  expect(competing.ok).toBe(false);
  if (!competing.ok) expect(competing.error.code).toBe('BUSY');
  expect(competing.session?.runningActionId).not.toBeNull();
  await running;
  expect(session.lastResult?.verification?.status).toBe('passed');
});

test('repeated delivery of the same action ID never repeats the click', async () => {
  const actionId = crypto.randomUUID();
  const action: Action = { type: 'click', target: selector('#fixture-reveal'), timeoutMs: 1_000 };
  const condition: VerificationCondition = { type: 'element_visible', target: selector('#fixture-result') };
  await act(action, condition, actionId);
  await act(action, condition, actionId);
  await expect(page.locator('#fixture-count')).toHaveText('1');
});

test('rejects stale observation references after a page mutation', async () => {
  const element = session.observation.elements.find((entry) => entry.name === 'Search');
  expect(element).toBeDefined();
  const observationId = session.observation.id;
  await page.locator('#fixture-search').evaluate((input) => input.setAttribute('placeholder', 'Layout changed'));
  await act({ type: 'click', target: { strategy: 'element_ref', observationId, ref: element!.ref }, timeoutMs: 300 }, focused);
  expect(session.lastResult?.error?.code).toBe('STALE_OBSERVATION');
  expect(session.lastResult?.dispatchStatus).toBe('not_dispatched');
  await observe();
  await act({ type: 'click', target: selector('#fixture-search'), timeoutMs: 1_000 }, focused);
  expect(session.lastResult?.verification?.status).toBe('passed');
});

test('blocks consequential controls and sensitive input without dispatch', async () => {
  for (const id of ['#fixture-purchase', '#fixture-send', '#fixture-submit']) {
    await act({ type: 'click', target: selector(id), timeoutMs: 300 }, focused);
    expect(session.lastResult?.error?.code).toBe('POLICY_BLOCKED');
    expect(session.lastResult?.dispatchStatus).toBe('not_dispatched');
  }
  await expect(page.locator('#fixture-danger-count')).toHaveText('Consequential attempts: 0');
  await act({ type: 'type', target: selector('#fixture-controlled'), text: 'person@example.test', timeoutMs: 300 }, focused);
  expect(session.lastResult?.error?.code).toBe('POLICY_BLOCKED');
});

test('blocks screenshots while private fixture samples exist and never persists image bytes', async () => {
  const response = await observe(true);
  expect(response.ok && response.screenshotDataUrl).toBeFalsy();
  expect(session.observation.screenshot.status).toBe('omitted');
  if (session.observation.screenshot.status === 'omitted') expect(session.observation.screenshot.reason).toContain('sensitive');
  const storage = await panel.evaluate(() => chrome.storage.session.get(null));
  expect(JSON.stringify(storage)).not.toContain('data:image');
});

test('refuses a different active tab and stops the old session', async () => {
  const other = await context.newPage();
  await other.goto('http://127.0.0.1:4173/sidepanel.html');
  await other.bringToFront();
  const response = await command({ kind: 'observe_fixture', sessionId: session.id, screenshot: true });
  expect(response.ok).toBe(false);
  expect(response.session?.stopped).toBe(true);
  await other.close();
});

test('rejects binding a non-fixture page even on the allowed local host', async () => {
  await page.goto('http://127.0.0.1:4173/sidepanel.html');
  const response = await command({ kind: 'bind_fixture' });
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe('PERMISSION_REQUIRED');
});

test('invalidates old document bindings after reload', async () => {
  await page.reload();
  const response = await act({ type: 'click', target: selector('#fixture-search'), timeoutMs: 300 }, focused);
  expect(response.ok).toBe(false);
  await expect(page.locator('#fixture-search')).not.toBeFocused();
  const rebound = await command({ kind: 'bind_fixture' });
  expect(rebound.ok).toBe(true);
  await act({ type: 'click', target: selector('#fixture-search'), timeoutMs: 1_000 }, focused);
  expect(session.lastResult?.verification?.status).toBe('passed');
});

test('rejects arbitrary JavaScript and unsupported selectors', async () => {
  const response = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'execute_fixture', code: 'document.cookie' }));
  expect(response.ok).toBe(false);
  await act({ type: 'click', target: selector('button:first-child'), timeoutMs: 300 }, focused);
  expect(session.lastResult?.error?.code).toBe('UNSUPPORTED_SELECTOR');
});

test('rejects a covered target instead of invoking its hidden click handler', async () => {
  await page.locator('#fixture-reveal').evaluate((button) => {
    const cover = document.createElement('div');
    const rect = button.getBoundingClientRect();
    Object.assign(cover.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: 'white', zIndex: '9999' });
    document.body.append(cover);
  });
  await observe();
  await act({ type: 'click', target: selector('#fixture-reveal'), timeoutMs: 300 }, focused);
  expect(session.lastResult?.error?.code).toBe('TARGET_DISABLED');
  await expect(page.locator('#fixture-result')).toBeHidden();
});

test('rejects unimplemented verification before dispatching an action', async () => {
  await act({ type: 'click', target: selector('#fixture-reveal'), timeoutMs: 300 }, { type: 'semantic_assessment_required', criterion: 'Interpret the whole page' });
  expect(session.lastResult?.dispatchStatus).toBe('not_dispatched');
  expect(session.lastResult?.error?.code).toBe('UNSUPPORTED_ACTION');
  await expect(page.locator('#fixture-result')).toBeHidden();
});

test('uses a fresh observation-scoped reference for a real click', async () => {
  const element = session.observation.elements.find((entry) => entry.name === 'Search');
  expect(element).toBeDefined();
  await act({ type: 'click', target: { strategy: 'element_ref', observationId: session.observation.id, ref: element!.ref }, timeoutMs: 1_000 }, focused);
  expect(session.lastResult?.verification?.status).toBe('passed');
});

test('captures a safe fixture or reports the missing activeTab grant explicitly', async () => {
  await page.getByLabel('Show privacy test samples').uncheck();
  // Phase 7 also omits screenshots of populated text fields, even when their labels look safe.
  await page.evaluate(() => { for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="text"], input[type="search"], textarea')) element.value = ''; });
  const response = await observe(true);
  if (session.observation.screenshot.status === 'captured') {
    expect(response.ok && response.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(session.observation.screenshot.width).toBeGreaterThan(0);
    console.info('Real Chrome screenshot capture: passed.');
  } else {
    expect(session.observation.screenshot.reason).toContain('Chrome did not permit');
    test.info().annotations.push({ type: 'limitation', description: 'ActiveTab user grant was not available; the real Chrome capture error was handled explicitly.' });
    console.info('Real Chrome screenshot capture: user activeTab grant unavailable; omission verified.');
  }
  const storage = await panel.evaluate(() => chrome.storage.session.get(null));
  expect(JSON.stringify(storage)).not.toContain('data:image');
});

test('panel buttons drive actual fixture actions and expose verified outcomes', async () => {
  await panel.getByRole('button', { name: 'Bind current page', exact: true }).press('Tab');
  await expect(panel.getByRole('checkbox', { name: 'Request a screenshot when safe' })).toBeFocused();
  await panel.getByRole('checkbox', { name: 'Request a screenshot when safe' }).press('Tab');
  await expect(panel.getByRole('button', { name: 'Observe page', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Observe page', exact: true }).press('Tab');
  await expect(panel.getByRole('button', { name: 'Stop tools', exact: true })).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Stop tools', exact: true })).toHaveCSS('outline-width', '3px');
  await expect(panel.getByRole('button', { name: 'Focus search', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Focus search', exact: true }).click();
  await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  await expect(page.locator('#fixture-search')).toBeFocused();
  await panel.getByRole('button', { name: 'Type test query', exact: true }).click();
  await expect(page.locator('#fixture-controlled-output')).toHaveText('Controlled value: laptops');
  await expect(panel.getByText('Verified', { exact: true })).toBeVisible();
  await panel.screenshot({ path: 'test-results/clickflow-phase-2-panel.png', fullPage: true });
  await panel.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await panel.locator('.fixture-tools').screenshot({ path: 'test-results/clickflow-phase-2-tools.png' });
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  await expect(panel.getByRole('button', { name: 'Check connection' })).toHaveCSS('transition-duration', '0s');
  await panel.setViewportSize({ width: 320, height: 844 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('does not expose private descendants through accessible labels or button names', async () => {
  await page.locator('label[for="fixture-search"]').evaluate((label) => {
    const privateText = document.createElement('span');
    privateText.dataset.sensitive = 'true'; privateText.textContent = 'nested-private-fixture-sentinel';
    label.append(privateText);
  });
  await page.locator('#fixture-no-change').evaluate((button) => {
    const privateText = document.createElement('span');
    privateText.dataset.private = 'true'; privateText.textContent = 'nested-private-fixture-sentinel';
    button.append(privateText);
  });
  await observe();
  expect(JSON.stringify(session.observation)).not.toContain('nested-private-fixture-sentinel');
});

test('clears a controlled React input and verifies its rendered empty value', async () => {
  await act({ type: 'type', target: selector('#fixture-controlled'), text: 'temporary', timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-controlled'), value: 'temporary' });
  await observe();
  await act({ type: 'clear_input', target: selector('#fixture-controlled'), timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-controlled'), value: '' });
  expect(session.lastResult?.verification?.status).toBe('passed');
  await expect(page.locator('#fixture-controlled-output')).toHaveText('Controlled value: (empty)');
});

test('types and clears a textarea and changes a native select option', async () => {
  await page.locator('#fixture-notes').scrollIntoViewIfNeeded(); await observe();
  await act({ type: 'type', target: selector('#fixture-notes'), text: 'Local notes', timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-notes'), value: 'Local notes' });
  expect(session.lastResult?.verification?.status).toBe('passed'); await observe();
  await act({ type: 'clear_input', target: selector('#fixture-notes'), timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-notes'), value: '' });
  expect(session.lastResult?.verification?.status).toBe('passed');
  await page.locator('#fixture-select').scrollIntoViewIfNeeded(); await observe();
  await act({ type: 'select_option', target: { strategy: 'label', label: 'Sort order', exact: true }, value: 'rating', timeoutMs: 1000 }, { type: 'selected_option_equals', target: selector('#fixture-select'), value: 'rating' });
  expect(session.lastResult?.verification?.status).toBe('passed'); await expect(page.locator('#fixture-select')).toHaveValue('rating');
});

test('presses Enter on a safe button and Backspace in a text input', async () => {
  await act({ type: 'press_key', target: selector('#fixture-reveal'), key: 'Enter', timeoutMs: 1000 }, { type: 'element_visible', target: selector('#fixture-result') });
  expect(session.lastResult?.verification?.status).toBe('passed'); await observe();
  await act({ type: 'type', target: selector('#fixture-search'), text: 'abc', timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-search'), value: 'abc' });
  await observe(); await act({ type: 'press_key', target: selector('#fixture-search'), key: 'Backspace', timeoutMs: 1000 }, { type: 'input_value_equals', target: selector('#fixture-search'), value: 'ab' });
  expect(session.lastResult?.verification?.status).toBe('passed');
});

test('verifies counts and scroll displacement without interpreting dispatch as success', async () => {
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await act({ type: 'observe', timeoutMs: 1000 }, { type: 'element_count', target: { strategy: 'role', role: 'button', name: 'Duplicate target', exact: true }, count: 2 });
  expect(session.lastResult?.verification?.status).toBe('passed'); await observe();
  await act({ type: 'scroll', direction: 'down', pixels: 300, timeoutMs: 1000 }, { type: 'scroll_position_changed', axis: 'y', minDelta: 50 });
  expect(session.lastResult?.verification?.status).toBe('passed'); expect(session.observation.scroll.y).toBeGreaterThan(0);
});

test('waits for a relevant delayed predicate and permits Stop during a wait', async () => {
  await page.locator('#fixture-delay').click(); await observe();
  await act({ type: 'wait', timeoutMs: 3000 }, { type: 'text_present', text: 'Delayed result is ready.' });
  expect(session.lastResult?.verification?.status).toBe('passed'); await observe();
  const pending = act({ type: 'wait', timeoutMs: 5000 }, { type: 'text_present', text: 'Never appears' });
  await expect.poll(async () => (await command({ kind: 'get_fixture_state' })).session?.runningActionId).not.toBeNull();
  await command({ kind: 'stop_fixture', sessionId: session.id }); await pending;
  expect(session.stopped).toBe(true); expect(session.lastResult?.verification?.status).not.toBe('passed');
});

test('extracts bounded text with source URL, time and a typed record', async () => {
  await page.locator('#fixture-extract').scrollIntoViewIfNeeded(); await observe();
  await act({ type: 'extract_text', target: { strategy: 'text', text: 'Aster laptop: 16 GB RAM, 512 GB storage.', exact: true }, outputKey: 'product', maxCharacters: 100, timeoutMs: 1000 }, { type: 'extracted_data_matches_schema', outputKey: 'product', schemaId: 'text-v1' });
  expect(session.lastResult?.verification?.status).toBe('passed');
  expect(session.lastResult?.extraction).toMatchObject({ outputKey: 'product', schemaId: 'text-v1', text: 'Aster laptop: 16 GB RAM, 512 GB storage.', sourceUrl: page.url(), observationId: session.observation.id });
});

test('navigates, rebinds fresh documents, goes back and forward only within agent history', async () => {
  const original = session.documentId;
  const details = 'http://127.0.0.1:4173/fixtures/details.html'; const home = 'http://127.0.0.1:4173/fixtures/browser.html';
  await act({ type: 'navigate', url: details, timeoutMs: 5000 }, { type: 'url_matches', url: details, match: 'exact' });
  expect(session.lastResult?.verification?.status).toBe('passed'); expect(session.documentId).not.toBe(original); await expect(page).toHaveURL(details);
  await act({ type: 'go_back', timeoutMs: 5000 }, { type: 'url_matches', url: home, match: 'exact' });
  expect(session.lastResult?.verification?.status).toBe('passed'); await expect(page).toHaveURL(home);
  await act({ type: 'go_forward', timeoutMs: 5000 }, { type: 'url_matches', url: details, match: 'exact' });
  expect(session.lastResult?.verification?.status).toBe('passed'); await expect(page).toHaveURL(details);
});

test('finish requests assessment and never produces passing completion evidence', async () => {
  await act({ type: 'finish', timeoutMs: 1000 }, { type: 'semantic_assessment_required', criterion: 'Assess original goal' });
  expect(session.lastResult?.verification?.status).toBe('unknown'); expect(session.lastResult?.verification?.evidence).toHaveLength(0);
});

test('rejects unknown history and unavailable select options before dispatch', async () => {
  const before = page.url();
  const back = await act({ type: 'go_back', timeoutMs: 1000 }, { type: 'url_matches', url: 'http://127.0.0.1:4173/fixtures/details.html', match: 'exact' });
  expect(back.ok).toBe(false); await expect(page).toHaveURL(before);
  await page.locator('#fixture-select').scrollIntoViewIfNeeded(); await observe();
  await act({ type: 'select_option', target: selector('#fixture-select'), value: 'does-not-exist', timeoutMs: 1000 }, { type: 'selected_option_equals', target: selector('#fixture-select'), value: 'does-not-exist' });
  expect(session.lastResult?.dispatchStatus).toBe('not_dispatched'); await expect(page.locator('#fixture-select')).toHaveValue('price');
});

test('Stop during navigation rebinding never leaves an active replacement session', async () => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const state = globalThis as typeof globalThis & { restoreNavigationInjection?: () => void };
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    state.restoreNavigationInjection = () => { chrome.scripting.executeScript = original; };
    chrome.scripting.executeScript = (async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      await chrome.storage.session.set({ navigationTestPending: true });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return original(injection);
    }) as typeof chrome.scripting.executeScript;
  });
  try {
    const id = session.id; const url = 'http://127.0.0.1:4173/fixtures/details.html';
    const pending = act({ type: 'navigate', url, timeoutMs: 5000 }, { type: 'url_matches', url, match: 'exact' });
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('navigationTestPending')).navigationTestPending)).toBe(true);
    await command({ kind: 'stop_fixture', sessionId: id }); await pending;
    expect(session.stopped).toBe(true); expect(session.lastResult?.verification?.status).not.toBe('passed');
  } finally {
    await worker.evaluate(async () => {
      (globalThis as typeof globalThis & { restoreNavigationInjection?: () => void }).restoreNavigationInjection?.();
      await chrome.storage.session.remove('navigationTestPending');
    });
  }
});

test('Stop during a slow rebind cannot create a new unstopped session afterward', async () => {
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const state = globalThis as typeof globalThis & { restoreFixtureInjection?: () => void };
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    state.restoreFixtureInjection = () => { chrome.scripting.executeScript = original; };
    chrome.scripting.executeScript = (async (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
      await chrome.storage.session.set({ fixtureTestInjectionPending: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return original(injection);
    }) as typeof chrome.scripting.executeScript;
  });
  try {
    const originalSessionId = session.id;
    const binding = command({ kind: 'bind_fixture' });
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('fixtureTestInjectionPending')).fixtureTestInjectionPending)).toBe(true);
    await command({ kind: 'stop_fixture', sessionId: originalSessionId });
    const rebound = await binding;
    expect(rebound.ok).toBe(false);
    if (!rebound.ok) expect(rebound.error.code).toBe('STOPPED');
    expect(rebound.session?.stopped).toBe(true);
    expect(rebound.session?.id).toBe(originalSessionId);
  } finally {
    await worker.evaluate(async () => {
      (globalThis as typeof globalThis & { restoreFixtureInjection?: () => void }).restoreFixtureInjection?.();
      await chrome.storage.session.remove('fixtureTestInjectionPending');
    });
  }
});
