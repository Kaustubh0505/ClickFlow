import {
  browserToolResponseSchema, contentResponseSchema, taskControlCommandSchema, taskExecutionCommandSchema,
  type ActionJournal, type BrowserToolResponse, type ContentCommand, type FixtureSession, type TaskControlResponse, type TaskExecutionCommand, type TaskState,
} from '@clickflow/shared';
import { ExecutionJournal, sameIntent } from './journal.js';
import { OutcomeOutbox } from './outbox.js';
import { backendTask, TransportError } from './task-transport.js';

type Browser = {
  tool: (input: unknown) => Promise<BrowserToolResponse>;
  interrupt: (sessionId?: string) => Promise<void>;
  cachedResult: (record: ActionJournal) => Promise<unknown>;
  checkState: (session: FixtureSession, command: Extract<ContentCommand, { kind: 'content_check_state' }>) => Promise<unknown>;
};
const errorResponse = (message: string): BrowserToolResponse => ({ ok: false, session: null, error: { code: 'INTERRUPTED', message } });

/** Owns task dispatch and its outbox independently of the panel lifetime. No replay path executes DOM. */
export class TaskCoordinator {
  readonly journal = new ExecutionJournal(chrome.storage.local);
  readonly outbox = new OutcomeOutbox(this.journal);
  private running = false;
  private reconciling = false;
  private readonly cancelled = new Set<string>();
  private currentSession: string | undefined;
  constructor(private readonly browser: Browser) {}

  private async migrateLegacy(task: TaskState) {
    const raw = (await chrome.storage.local.get('clickflowPreparedTask')).clickflowPreparedTask as Record<string, unknown> | null | undefined;
    if (!raw?.actionId) return;
    const state = await this.journal.read();
    if (state.active?.command.authorization.actionId === raw.actionId || state.receipts.some((entry) => entry.actionId === raw.actionId)) return;
    const parsed = taskExecutionCommandSchema.safeParse({ kind: raw.kind, sessionId: raw.sessionId, authorization: raw.authorization, verification: raw.verification, ...(raw.approval ? { approval: raw.approval } : {}) });
    if (!parsed.success) throw new TransportError('RECONCILIATION_REQUIRED', 'An older dispatch journal is incomplete. It will not be replayed; inspect or restore its checkpoint.');
    const command = parsed.data;
    const owner = task.id === command.authorization.taskId ? task : await backendTask(`/${command.authorization.taskId}`);
    if (owner.actionHistory.some((entry) => entry.authorization.actionId === command.authorization.actionId) || owner.cancellationRequested) {
      await this.journal.update((current) => ({ ...current, receipts: [...current.receipts, { taskId: owner.id, actionId: command.authorization.actionId,
        phase: owner.cancellationRequested ? 'cancelled_unresolved' as const : 'acknowledged' as const, at: new Date().toISOString() }].slice(-200) }));
      return;
    }
    if (state.active && state.active.phase !== 'acknowledged') throw new TransportError('RECONCILIATION_REQUIRED', 'Two unresolved checkpoints need inspection. No action was repeated.');
    const response = browserToolResponseSchema.safeParse(raw.response);
    const result = response.success && response.data.session?.lastResult?.actionId === command.authorization.actionId ? response.data.session.lastResult : null;
    const context = owner.currentContext ?? owner.initialContext;
    if (!context) throw new TransportError('INVALID_RESPONSE', 'The old action has no browser identity.');
    await this.journal.update((current) => ({ ...current, active: { version: 1, command, browser: { tabId: context.tabId, windowId: context.windowId, documentId: context.documentId },
      phase: result ? 'outcome_ready' : 'uncertain', updatedAt: new Date().toISOString(), result, report: null, allowTabRelink: false } }));
  }
  private async releasePrevious(task: TaskState) {
    const record = (await this.journal.read()).active;
    if (!record || record.phase === 'acknowledged') return;
    const owner = record.command.authorization.taskId === task.id ? task : await backendTask(`/${record.command.authorization.taskId}`);
    if (owner.actionHistory.some((entry) => entry.authorization.actionId === record.command.authorization.actionId)) await this.journal.acknowledge(record.command.authorization.actionId);
    else if (owner.cancellationRequested) await this.journal.acknowledge(record.command.authorization.actionId, true);
  }
  private async prepare(command: TaskExecutionCommand) {
    const task = await backendTask(`/${command.authorization.taskId}`);
    await this.journal.checkpoint(task);
    await this.migrateLegacy(task); await this.releasePrevious(task);
    const pending = task.pendingAction;
    if (this.cancelled.has(task.id) || task.cancellationRequested || task.resumeRequired || task.planNeedsRecovery || !pending
      || !['executing', 'awaiting_confirmation'].includes(task.status)
      || JSON.stringify(pending.authorization) !== JSON.stringify(command.authorization) || JSON.stringify(pending.verification) !== JSON.stringify(command.verification)
      || Date.parse(command.authorization.leaseExpiresAt) < Date.now()) throw new TransportError('STALE_TASK', 'This authorization is stale, cancelled or requires resume. No action was dispatched.');
    const response = await this.browser.tool({ kind: 'get_fixture_state' });
    if (!response.ok || !response.session || response.session.id !== command.sessionId || response.session.stopped || response.session.observation.id !== command.authorization.observationId) throw new TransportError('DOCUMENT_CHANGED', 'Re-observe and review the current page before dispatch.');
    this.currentSession = command.sessionId;
    const prepared = await this.journal.prepare(command, { tabId: response.session.tabId, windowId: response.session.windowId, documentId: response.session.documentId });
    if (prepared.active?.phase !== 'prepared') throw new TransportError('RECONCILIATION_REQUIRED', 'The saved action may already have been sent. Resume it without replay.');
    return response;
  }
  async execute(input: unknown): Promise<BrowserToolResponse> {
    const command = taskExecutionCommandSchema.parse(input);
    if (this.running || this.reconciling) return errorResponse('An action or reconciliation is running. No competing action was scheduled.');
    this.running = true;
    try {
      const state = await this.journal.read();
      if (this.cancelled.has(command.authorization.taskId) || state.cancellations.some((entry) => entry.taskId === command.authorization.taskId)) return errorResponse('This task was stopped locally. It cannot dispatch again.');
      if (state.receipts.some((entry) => entry.actionId === command.authorization.actionId) && state.active?.command.authorization.actionId !== command.authorization.actionId) return errorResponse('This action ID already has a durable receipt. Inspect its backend outcome; it will not be sent again.');
      const previous = state.active;
      if (previous?.command.authorization.actionId === command.authorization.actionId) {
        if (!sameIntent(previous.command, command)) return errorResponse('An action ID cannot be reused with changed details.');
        if (previous.result) {
          void this.outbox.flush().catch(() => undefined);
          const response = await this.browser.tool({ kind: 'get_fixture_state' });
          return { ok: true, session: response.session ? { ...response.session, lastResult: previous.result } : null };
        }
        if (previous.phase !== 'prepared') return errorResponse('This action may have been sent. Resume will reconcile it without replay.');
      }
      await this.prepare(command);
      if (command.authorization.requiresConfirmation && !command.approval) return errorResponse('Review and explicitly approve this action first.');
      await this.journal.transition(command.authorization.actionId, (record) => ({ ...record, phase: 'dispatching', command }));
      // Stop can arrive during any awaited checkpoint. Its in-memory tombstone is immediate.
      if (this.cancelled.has(command.authorization.taskId)) return errorResponse('Stopped before dispatch. Resume will inspect the checkpoint.');
      if (command.authorization.protocolVersion === 2) {
        const claimed = await backendTask(`/${command.authorization.taskId}/claim`, { actionId: command.authorization.actionId, leaseId: command.authorization.leaseId });
        if (!claimed.dispatchClaims.some((entry) => entry.actionId === command.authorization.actionId && entry.leaseId === command.authorization.leaseId)) throw new TransportError('INVALID_RESPONSE', 'The dispatch claim was not checkpointed.');
        await this.journal.checkpoint(claimed);
      }
      await chrome.storage.local.set({ clickflowPreparedTask: { ...command, actionId: command.authorization.actionId, response: null } });
      if (this.cancelled.has(command.authorization.taskId)) return errorResponse('Stopped before dispatch.');
      const response = await this.browser.tool({ kind: 'execute_fixture', sessionId: command.sessionId, actionId: command.authorization.actionId,
        action: command.authorization.action, verification: command.verification, ...(command.approval ? { approval: command.approval } : {}) });
      const result = response.session?.lastResult?.actionId === command.authorization.actionId ? response.session.lastResult : null;
      await this.journal.transition(command.authorization.actionId, (record) => ({ ...record, phase: result ? 'outcome_ready' : 'uncertain', result }));
      await chrome.storage.local.set({ clickflowPreparedTask: { ...command, actionId: command.authorization.actionId, response } });
      void this.outbox.flush().catch(() => undefined);
      return response;
    } catch (error) {
      return errorResponse(error instanceof TransportError ? error.message : 'The durable dispatch checkpoint could not be confirmed. Resume without repeating the action.');
    } finally { this.running = false; }
  }
  async control(input: unknown): Promise<TaskControlResponse> {
    const command = taskControlCommandSchema.parse(input);
    const response: TaskControlResponse = { ok: true, task: null, browser: null, journal: null, error: null };
    const exclusive = command.kind === 'checkpoint_task_action' || command.kind === 'record_preflight_failure' || command.kind === 'sync_task' && command.resume;
    if (exclusive && (this.reconciling || this.running)) return { ...response, ok: false, error: { code: 'BUSY', message: 'An action or reconciliation is still running. Wait for its checkpoint, or use Stop.' } };
    if (exclusive) this.reconciling = true;
    try {
      if (command.kind === 'persist_task_checkpoint') { await this.journal.checkpoint(command.task); return { ...response, task: command.task }; }
      if (command.kind === 'stop_task') {
        this.cancelled.add(command.taskId);
        const stopping = this.browser.interrupt(this.currentSession); // Synchronous epoch invalidation precedes storage/network work.
        // Cancellation delivery does not wait behind an older outcome's network backoff, and
        // still runs when durable storage fails. It can never revive or schedule the task.
        const notify = backendTask(`/${command.taskId}/stop`, {}).then(async (task) => {
          if (task.cancellationRequested || ['failed', 'completed'].includes(task.status)) {
            await this.journal.update((state) => ({ ...state, cancellations: state.cancellations.map((entry) => entry.taskId === task.id ? { ...entry, acknowledged: true } : entry) }));
            await this.journal.checkpoint(task);
          }
          return task;
        }).catch(() => null);
        try { await this.journal.cancel(command.taskId); } catch (error) { await stopping.catch(() => undefined); response.task = await notify; throw error; }
        await stopping; response.task = await notify;
        await this.outbox.flush();
        response.task = await backendTask(`/${command.taskId}`).catch(() => response.task);
      } else if (command.kind === 'record_preflight_failure') {
        const record = (await this.journal.read()).active;
        if (!record || record.phase !== 'prepared' || record.command.authorization.taskId !== command.taskId || record.command.authorization.actionId !== command.actionId) throw new TransportError('RECONCILIATION_REQUIRED', 'A preflight failure cannot replace a potentially dispatched action.');
        await this.journal.transition(command.actionId, (active) => {
          if (active.phase !== 'prepared') throw new TransportError('RECONCILIATION_REQUIRED', 'Dispatch already began; preflight proof is invalid.');
          return { ...active, phase: 'outcome_ready', result: { actionId: command.actionId, actionType: active.command.authorization.action.type,
            dispatchStatus: 'not_dispatched', recordedAt: new Date().toISOString(), verification: null, observation: null, extraction: null, error: command.error } };
        });
        await this.outbox.flush(); response.task = await backendTask(`/${command.taskId}`);
      } else if (command.kind === 'checkpoint_task_action') {
        if (this.running) throw new TransportError('BUSY', 'An action is already running.');
        response.browser = await this.prepare({ ...command, kind: 'execute_task_action' });
      } else {
        await this.outbox.flush();
        let task = await backendTask(`/${command.taskId}`); response.task = task;
        await this.journal.checkpoint(task);
        if (command.resume && !task.cancellationRequested && !['completed', 'failed', 'planning', 'recovering', 'waiting_for_model'].includes(task.status)) {
          if (this.running) throw new TransportError('BUSY', 'The current action is still finishing. Resume after its outcome is checkpointed, or use Stop to cancel.');
          await this.migrateLegacy(task); await this.releasePrevious(task);
          let record = (await this.journal.read()).active;
          if (record && record.command.authorization.taskId === task.id && ['dispatching', 'uncertain'].includes(record.phase)) {
            await this.browser.interrupt(record.command.sessionId);
            try {
              const cached = contentResponseSchema.parse(await this.browser.cachedResult(record));
              if (cached.kind === 'cached_result' && cached.result?.actionId === record.command.authorization.actionId) {
                await this.journal.transition(record.command.authorization.actionId, (active) => ({ ...active, result: cached.result, phase: 'outcome_ready' }));
                await this.outbox.flush(); task = await backendTask(`/${task.id}`); response.task = task;
              }
            } catch { /* A missing document is uncertainty, never permission to repeat the action. */ }
          }
          const fresh = await this.browser.tool({ kind: 'bind_fixture' }); response.browser = fresh;
          if (!fresh.ok || !fresh.session) throw new TransportError('DOCUMENT_CHANGED', fresh.ok ? 'Bind the permitted original page first.' : fresh.error.message);
          const uncertain = [...task.actionHistory].reverse().find((entry) => entry.dispatchStatus === 'uncertain' && !task.reconciliationHistory.some((item) => item.actionId === entry.authorization.actionId && item.resolution === 'state_verified'));
          const pending = task.pendingAction;
          if (pending || uncertain) {
            const authorization = pending?.authorization ?? uncertain!.authorization;
            const verification = pending?.verification ?? uncertain?.verification?.condition ?? task.plan!.steps.find((step) => step.id === authorization.stepId)!.verification;
            record = (await this.journal.read()).active;
            const backendPrepared = authorization.protocolVersion === 2 && !task.dispatchClaims.some((entry) => entry.actionId === authorization.actionId && entry.leaseId === authorization.leaseId);
            const provenPrepared = backendPrepared || authorization.protocolVersion === 1 && record?.command.authorization.actionId === authorization.actionId
              && (record.phase === 'prepared' || record.phase === 'reconciliation_ready' && record.report?.resolution === 'not_dispatched' && record.report.source === 'prepared_journal');
            const checked = provenPrepared ? { kind: 'checked_state' as const, observation: fresh.session.observation, verification: null } : contentResponseSchema.parse(await this.browser.checkState(fresh.session, { kind: 'content_check_state', sessionId: fresh.session.id,
              tabId: fresh.session.tabId, windowId: fresh.session.windowId, documentId: fresh.session.documentId, zoom: fresh.session.observation.viewport.zoom,
              action: authorization.action, verification }));
            if (checked.kind !== 'checked_state') throw new TransportError('INVALID_RESPONSE', 'The read-only state check failed.');
            const report = { id: crypto.randomUUID(), actionId: authorization.actionId, leaseId: authorization.leaseId,
              resolution: provenPrepared ? 'not_dispatched' as const : checked.verification?.status === 'passed' ? 'state_verified' as const : 'unresolved' as const,
              source: provenPrepared ? backendPrepared ? 'backend_prepared' as const : 'prepared_journal' as const : 'fresh_state' as const, observation: checked.observation, verification: provenPrepared ? null : checked.verification };
            if (!record || record.command.authorization.actionId !== authorization.actionId) {
              if (record && record.phase !== 'acknowledged') throw new TransportError('RECONCILIATION_REQUIRED', 'Another action journal is unresolved.');
              const previous = task.currentContext ?? task.initialContext!;
              await this.journal.update((state) => ({ ...state, active: { version: 1, command: { kind: 'execute_task_action', sessionId: fresh.session!.id, authorization, verification },
                browser: { tabId: previous.tabId, windowId: previous.windowId, documentId: previous.documentId }, phase: 'uncertain', result: null, report: null, updatedAt: new Date().toISOString(), allowTabRelink: command.allowTabRelink } }));
            }
            await this.journal.transition(authorization.actionId, (active) => ({ ...active, report, phase: report.resolution === 'unresolved' ? 'uncertain' : 'reconciliation_ready', allowTabRelink: command.allowTabRelink }));
            task = await backendTask(`/${task.id}/reconcile`, { expectedRevision: task.revision, report, allowTabRelink: command.allowTabRelink });
            response.task = task; await this.journal.checkpoint(task);
            if (report.resolution !== 'unresolved') {
              if (!task.actionHistory.some((entry) => entry.authorization.actionId === authorization.actionId)
                || !task.reconciliationHistory.some((entry) => entry.actionId === authorization.actionId && entry.resolution === report.resolution)) throw new TransportError('INVALID_RESPONSE', 'The reconciliation receipt was not acknowledged.');
              await this.journal.acknowledge(authorization.actionId);
            }
            else response.error = { code: 'RECONCILIATION_REQUIRED', message: 'The action may have occurred. It was not repeated. Inspect the website; Stop this task if its outcome cannot be recovered.' };
          } else {
            task = await backendTask(`/${task.id}/resume`, { expectedRevision: task.revision, observation: fresh.session.observation, allowTabRelink: command.allowTabRelink });
            response.task = task; await this.journal.checkpoint(task);
          }
        }
      }
      response.journal = await this.journal.read(); return response;
    } catch (error) {
      response.ok = false;
      response.error = error instanceof TransportError ? { code: error.code, message: error.message } : { code: 'JOURNAL_ERROR', message: 'The durable checkpoint could not be read or stored. No action was repeated.' };
      response.journal = await this.journal.read().catch(() => null); return response;
    } finally { if (exclusive) this.reconciling = false; }
  }
}
