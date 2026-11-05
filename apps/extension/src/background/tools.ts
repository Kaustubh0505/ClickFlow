import {
  browserToolCommandSchema, browserToolResponseSchema, contentResponseSchema,
  FIXTURE_URL, isSupportedPageUrl, taskControlResponseSchema,
} from '@clickflow/shared';
import type { BrowserToolResponse, ContentCommand, FixtureSession, ObservationFrame } from '@clickflow/shared';
import { BrowserToolError, messages, safeError } from '../browser/errors.js';
import type { BrowserErrorCode } from '../browser/errors.js';
import { readSession, updateSession } from './session-store.js';
import { jpegDimensions, ScreenshotService } from './screenshot.js';
import { assertPageAccess, changeOrigin } from './access.js';
import { TaskCoordinator } from './task-coordinator.js';

const screenshots = new ScreenshotService();
let activeOperation = false;
let stopEpoch = 0;
const stoppedSessions = new Set<string>();
let navigation: { tabId: number; controller: AbortController } | null = null;

async function assertActive(session: Pick<FixtureSession, 'tabId' | 'windowId'>): Promise<chrome.tabs.Tab> {
  const [tab, activeTabs, window] = await Promise.all([
    chrome.tabs.get(session.tabId), chrome.tabs.query({ active: true, windowId: session.windowId }), chrome.windows.get(session.windowId),
  ]);
  if (!window.focused || activeTabs[0]?.id !== session.tabId || tab.windowId !== session.windowId) throw new BrowserToolError('WRONG_TAB');
  if (!tab.url) throw new BrowserToolError('PERMISSION_REQUIRED');
  await assertPageAccess(tab.url);
  return tab;
}

async function requireSession(id: string, allowStopped = false): Promise<FixtureSession> {
  const session = await readSession();
  if (!session || session.id !== id) throw new BrowserToolError('DOCUMENT_CHANGED');
  if (!allowStopped && (session.stopped || stoppedSessions.has(id))) throw new BrowserToolError('STOPPED');
  return session;
}

async function content(session: Pick<FixtureSession, 'tabId' | 'documentId'>, command: ContentCommand) {
  const response: unknown = await chrome.tabs.sendMessage(session.tabId, command, { documentId: session.documentId });
  const parsed = contentResponseSchema.safeParse(response);
  if (!parsed.success) throw new BrowserToolError('INVALID_MESSAGE');
  if (parsed.data.kind === 'error') {
    const code = parsed.data.error.code;
    throw new BrowserToolError(code in messages ? code as BrowserErrorCode : 'CONNECTION_FAILED');
  }
  return parsed.data;
}

async function observe(session: FixtureSession): Promise<ObservationFrame> {
  await assertActive(session);
  if (stoppedSessions.has(session.id)) throw new BrowserToolError('STOPPED');
  const response = await content(session, {
    kind: 'content_observe', sessionId: session.id, tabId: session.tabId, windowId: session.windowId,
    documentId: session.documentId, zoom: await chrome.tabs.getZoom(session.tabId),
  });
  if (response.kind !== 'observed') throw new BrowserToolError('INVALID_MESSAGE');
  await assertActive(session);
  return response.frame;
}

async function bind(tab: chrome.tabs.Tab, expectedStopEpoch: number): Promise<FixtureSession> {
  if (tab.id === undefined || !tab.url) throw new BrowserToolError('PERMISSION_REQUIRED');
  await assertPageAccess(tab.url);
  const tabId = tab.id; const windowId = tab.windowId;
  await assertActive({ tabId, windowId });
  const previous = await readSession();
  if (previous) await stop(previous.id);
  const injected = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
  const documentId = injected[0]?.documentId;
  if (!documentId) throw new BrowserToolError('DOCUMENT_CHANGED');
  const id = crypto.randomUUID();
  const response = await content({ tabId, documentId }, { kind: 'content_observe', sessionId: id, tabId, windowId, documentId, zoom: await chrome.tabs.getZoom(tabId) });
  if (response.kind !== 'observed') throw new BrowserToolError('INVALID_MESSAGE');
  await assertActive({ tabId, windowId });
  if (stopEpoch !== expectedStopEpoch) {
    try { await content({ tabId, documentId }, { kind: 'content_stop', sessionId: id }); } catch { /* No action is permitted on a cancelled binding. */ }
    throw new BrowserToolError('STOPPED');
  }
  const saved = await updateSession(() => {
    if (stopEpoch !== expectedStopEpoch) throw new BrowserToolError('STOPPED');
    return { id, revision: 0, tabId, windowId, documentId, stopped: false, runningActionId: null, attemptedActionIds: [], observation: response.frame.observation, lastResult: null, lastError: null, navigationHistory: { urls: [response.frame.observation.url], index: 0 } };
  });
  if (stopEpoch !== expectedStopEpoch) { await stop(saved.id); throw new BrowserToolError('STOPPED'); }
  return saved;
}

async function stop(id: string): Promise<FixtureSession> {
  stoppedSessions.add(id); // Checked synchronously before any new dispatch in this worker.
  if (stoppedSessions.size > 100) stoppedSessions.delete(stoppedSessions.values().next().value ?? '');
  const session = await requireSession(id, true);
  const saved = await updateSession((current) => {
    if (!current || current.id !== id) throw new BrowserToolError('DOCUMENT_CHANGED');
    return { ...current, stopped: true };
  });
  try { await content(session, { kind: 'content_stop', sessionId: id }); } catch { /* Stop remains persisted even after navigation. */ }
  return saved;
}

async function waitForReady(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new BrowserToolError('CONNECTION_FAILED')); }, 10_000);
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(check); chrome.tabs.onRemoved.removeListener(removed); }
    function removed(id: number) { if (id === tabId) { cleanup(); reject(new BrowserToolError('CONNECTION_FAILED')); } }
    function check(id: number, _change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) {
      if (id === tabId && tab.status === 'complete') { cleanup(); resolve(tab); }
    }
    chrome.tabs.onUpdated.addListener(check);
    chrome.tabs.onRemoved.addListener(removed);
    void chrome.tabs.get(tabId).then((tab) => check(tabId, {}, tab), () => removed(tabId));
  });
}

export async function handleBrowserTool(input: unknown): Promise<BrowserToolResponse> {
  const parsed = browserToolCommandSchema.safeParse(input);
  if (!parsed.success) return { ok: false, session: null, error: safeError(new BrowserToolError('INVALID_MESSAGE')) };
  const command = parsed.data;
  try {
    if (command.kind === 'get_fixture_state') {
      let session = await readSession();
      if (session?.runningActionId && !activeOperation) {
        await stop(session.id);
        session = await updateSession((current) => ({ ...current!, runningActionId: null, stopped: true, lastError: safeError(new BrowserToolError('INTERRUPTED')) }));
      }
      return { ok: true, session };
    }
    if (command.kind === 'stop_fixture') { stopEpoch++; navigation?.controller.abort(); return { ok: true, session: await stop(command.sessionId) }; }
    if (command.kind === 'revoke_origin') {
      stopEpoch++; navigation?.controller.abort();
      await changeOrigin(command.origin, false);
      const session = await readSession();
      if (session && !session.stopped) await stop(session.id);
      return { ok: true, session: await readSession() };
    }
    if (activeOperation) throw new BrowserToolError('BUSY');
    activeOperation = true;
    const operationStopEpoch = stopEpoch;
    try {
      if (command.kind === 'grant_origin') { await changeOrigin(command.origin, true); return { ok: true, session: await readSession() }; }
      if (command.kind === 'open_fixture') {
        const tab = await chrome.tabs.create({ url: FIXTURE_URL, active: true });
        if (tab.id === undefined) throw new BrowserToolError('CONNECTION_FAILED');
        return { ok: true, session: await bind(await waitForReady(tab.id), operationStopEpoch) };
      }
      if (command.kind === 'bind_fixture') {
        const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (!tab) throw new BrowserToolError('FIXTURE_ONLY');
        return { ok: true, session: await bind(tab, operationStopEpoch) };
      }
      const session = await requireSession(command.sessionId);
      if (session.runningActionId) throw new BrowserToolError('INTERRUPTED');
      if (command.kind === 'check_goal_criteria') {
        await assertActive(session);
        const response = await content(session, { kind: 'content_check_criteria', sessionId: session.id, criteria: command.criteria,
          tabId: session.tabId, windowId: session.windowId, documentId: session.documentId, zoom: await chrome.tabs.getZoom(session.tabId) });
        await assertActive(session); await requireSession(session.id);
        if (response.kind !== 'checked_criteria') throw new BrowserToolError('INVALID_MESSAGE');
        const saved = await updateSession((current) => {
          if (!current || current.id !== session.id || current.stopped || stoppedSessions.has(session.id)) throw new BrowserToolError('STOPPED');
          return { ...current, observation: response.observation };
        });
        return { ok: true, session: saved, goalChecks: response.goalChecks };
      }
      if (command.kind === 'observe_fixture') {
        const captured = command.screenshot ? await screenshots.capture({
          assertActive: async () => { await assertActive(session); await requireSession(session.id); },
          observe: () => observe(session), capture: () => chrome.tabs.captureVisibleTab(session.windowId, { format: 'jpeg', quality: 70 }),
          dimensions: jpegDimensions, now: Date.now,
        }) : { observation: (await observe(session)).observation };
        const saved = await updateSession((current) => {
          if (!current || current.id !== session.id || current.stopped || stoppedSessions.has(session.id)) throw new BrowserToolError('STOPPED');
          return { ...current, observation: captured.observation, lastError: null };
        });
        return { ok: true, session: saved, ...('dataUrl' in captured && captured.dataUrl ? { screenshotDataUrl: captured.dataUrl } : {}) };
      }
      if (command.kind === 'prepare_action') {
        await assertActive(session);
        if (['navigate', 'go_back', 'go_forward'].includes(command.action.type)) {
          if (command.forceConfirmation) throw new BrowserToolError('UNSUPPORTED_ACTION');
          return { ok: true, session, confirmation: null };
        }
        const response = await content(session, { ...command, kind: 'content_prepare', tabId: session.tabId, windowId: session.windowId,
          documentId: session.documentId, zoom: await chrome.tabs.getZoom(session.tabId), expectedObservationId: session.observation.id, expectedRevision: session.observation.revision });
        await assertActive(session); await requireSession(session.id);
        if (response.kind !== 'prepared') throw new BrowserToolError('INVALID_MESSAGE');
        return { ok: true, session, confirmation: response.confirmation };
      }
      if (command.kind !== 'execute_fixture') throw new BrowserToolError('INVALID_MESSAGE');
      if (session.lastResult?.actionId === command.actionId) return { ok: true, session };
      if (session.attemptedActionIds.includes(command.actionId)) throw new BrowserToolError('DUPLICATE_ACTION');
      if (session.attemptedActionIds.length >= 50) throw new BrowserToolError('ACTION_LIMIT');
      await assertActive(session);
      await updateSession((current) => {
        if (!current || current.id !== session.id || current.stopped || stoppedSessions.has(session.id)) throw new BrowserToolError('STOPPED');
        return { ...current, runningActionId: command.actionId, attemptedActionIds: [...current.attemptedActionIds, command.actionId] };
      });
      await requireSession(session.id);
      if (['navigate', 'go_back', 'go_forward'].includes(command.action.type)) {
        if (command.verification.type !== 'url_matches' || command.verification.match !== 'exact') throw new BrowserToolError('UNSUPPORTED_ACTION');
        const history = session.navigationHistory.urls.length ? session.navigationHistory : { urls: [session.observation.url], index: 0 };
        const index = command.action.type === 'go_back' ? history.index - 1 : command.action.type === 'go_forward' ? history.index + 1 : history.index + 1;
        const url = command.action.type === 'navigate' ? command.action.url : history.urls[index];
        if (!url || !isSupportedPageUrl(url) || url === session.observation.url || command.verification.url !== url) throw new BrowserToolError('POLICY_BLOCKED');
        await assertPageAccess(url);
        const controller = new AbortController(); navigation = { tabId: session.tabId, controller };
        let dispatched = false;
        try {
          const arrived = new Promise<chrome.tabs.Tab>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(changed); controller.signal.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); reject(new BrowserToolError('CANCELLED')); };
            const changed = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
              if (id !== session.tabId) return;
              if (change.url && change.url !== url) { cleanup(); reject(new BrowserToolError('DOCUMENT_CHANGED')); return; }
              if (tab.status === 'complete' && tab.url === url) { cleanup(); resolve(tab); }
            };
            const timer = setTimeout(() => { cleanup(); reject(new BrowserToolError('CONNECTION_FAILED')); }, command.action.timeoutMs);
            chrome.tabs.onUpdated.addListener(changed); controller.signal.addEventListener('abort', abort, { once: true });
            dispatched = true;
            const dispatch = command.action.type === 'navigate' ? chrome.tabs.update(session.tabId, { url }) : command.action.type === 'go_back' ? chrome.tabs.goBack(session.tabId) : chrome.tabs.goForward(session.tabId);
            void dispatch.then(() => chrome.tabs.get(session.tabId)).then((tab) => changed(session.tabId, {}, tab), () => { cleanup(); reject(new BrowserToolError('CONNECTION_FAILED')); });
          });
          const tab = await arrived;
          const bound = await bind(tab, operationStopEpoch);
          const result = { actionId: command.actionId, actionType: command.action.type, dispatchStatus: 'dispatched' as const, recordedAt: new Date().toISOString(), observation: bound.observation, extraction: null, error: null,
            verification: { status: 'passed' as const, condition: command.verification, checkedAt: new Date().toISOString(), explanation: 'The expected fixture URL and a freshly bound document were observed.', evidence: [{ id: crypto.randomUUID(), observationId: bound.observation.id, capturedAt: bound.observation.capturedAt, sourceUrl: url, kind: 'navigation' as const, summary: 'The requested fixture navigation completed.' }] } };
          const saved = await updateSession((current) => {
            if (!current || current.id !== bound.id || current.stopped || operationStopEpoch !== stopEpoch) throw new BrowserToolError('STOPPED');
            return { ...current, lastResult: result, navigationHistory: { urls: command.action.type === 'navigate' ? [...history.urls.slice(0, history.index + 1), url] : history.urls, index } };
          });
          return { ok: true, session: saved };
        } catch (error) {
          const current = await readSession();
          if (!current) throw error;
          const saved = await updateSession((latest) => ({ ...latest!, runningActionId: null, stopped: true, lastResult: { actionId: command.actionId, actionType: command.action.type as 'navigate', dispatchStatus: dispatched ? 'uncertain' : 'not_dispatched', recordedAt: new Date().toISOString(), observation: null, extraction: null, verification: null, error: safeError(error) } }));
          return { ok: true, session: saved };
        } finally { navigation = null; }
      }
      const zoom = await chrome.tabs.getZoom(session.tabId);
      await assertActive(session);
      if (stoppedSessions.has(session.id) || operationStopEpoch !== stopEpoch) throw new BrowserToolError('STOPPED');
      const response = await content(session, {
        kind: 'content_execute', sessionId: session.id, tabId: session.tabId, windowId: session.windowId, documentId: session.documentId,
        zoom, actionId: command.actionId,
        expectedObservationId: session.observation.id, expectedRevision: session.observation.revision,
        action: command.action, verification: command.verification,
        ...(command.approval ? { approval: command.approval } : {}),
      });
      if (response.kind !== 'executed') throw new BrowserToolError('INVALID_MESSAGE');
      const saved = await updateSession((current) => {
        if (!current || current.id !== session.id) throw new BrowserToolError('DOCUMENT_CHANGED');
        return { ...current, runningActionId: null, lastResult: response.result, observation: response.result.observation ?? current.observation, lastError: response.result.error };
      });
      return { ok: true, session: saved };
    } finally { activeOperation = false; }
  } catch (error) {
    const session = await readSession();
    const normalized = safeError(error);
    if (normalized.code === 'BUSY') return { ok: false, session, error: normalized };
    if (session) {
      const saved = await updateSession((current) => ({ ...current!, runningActionId: null, lastError: normalized }));
      return { ok: false, session: saved, error: normalized };
    }
    return { ok: false, session: null, error: normalized };
  }
}


export function installBrowserTools(): void {
  const coordinator = new TaskCoordinator({
    tool: handleBrowserTool,
    interrupt: async (sessionId) => {
      stopEpoch++; navigation?.controller.abort();
      if (sessionId) stoppedSessions.add(sessionId);
      const session = await readSession();
      if (session) { stoppedSessions.add(session.id); await stop(session.id); }
    },
    cachedResult: async (record) => {
      const tab = await chrome.tabs.get(record.browser.tabId);
      if (!tab.url) throw new BrowserToolError('PERMISSION_REQUIRED');
      await assertPageAccess(tab.url);
      return content(record.browser, { kind: 'content_result', sessionId: record.command.sessionId, actionId: record.command.authorization.actionId });
    },
    checkState: async (session, command) => {
      await assertActive(session); const checked = await content(session, command); await assertActive(session); return checked;
    },
  });
  // Pairing credentials and dispatch journals are never readable by content scripts.
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void coordinator.outbox.flush().catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.clickflowAccessToken) void coordinator.outbox.flush().catch(() => undefined);
  });
  chrome.permissions.onRemoved.addListener(() => {
    stopEpoch++; navigation?.controller.abort();
    void readSession().then((session) => session && !session.stopped ? stop(session.id) : undefined).catch(() => undefined);
  });
  chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse) => {
    const allowed = sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('sidepanel.html');
    if (!allowed) return false;
    const isTask = !!input && typeof input === 'object' && 'kind' in input && input.kind === 'execute_task_action';
    const controlKinds = ['checkpoint_task_action', 'stop_task', 'sync_task', 'persist_task_checkpoint', 'record_preflight_failure'];
    const isControl = !!input && typeof input === 'object' && 'kind' in input && controlKinds.includes(String(input.kind));
    if (isControl) {
      void coordinator.control(input).then((response) => sendResponse(taskControlResponseSchema.parse(response)), () => sendResponse({ ok: false, task: null, browser: null, journal: null, error: { code: 'JOURNAL_ERROR', message: 'The checkpoint could not be synchronized.' } }));
    } else void (isTask ? coordinator.execute(input) : handleBrowserTool(input)).then((response) => sendResponse(browserToolResponseSchema.parse(response)), () => sendResponse({ ok: false, session: null, error: safeError(new BrowserToolError('CONNECTION_FAILED')) }));
    return true;
  });
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void readSession().then((session) => {
      if (session && !session.stopped && session.windowId === windowId && session.tabId !== tabId) return stop(session.id);
    }).catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (navigation?.tabId === tabId) return;
    if (change.status !== 'loading' && !change.url) return;
    void readSession().then((session) => {
      if (session && !session.stopped && session.tabId === tabId) return stop(session.id);
    }).catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void readSession().then((session) => { if (session?.tabId === tabId) return stop(session.id); }).catch(() => undefined);
  });
}
