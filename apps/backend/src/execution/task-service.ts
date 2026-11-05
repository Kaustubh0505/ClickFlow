import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  canReconcileFromState, isSupportedPageUrl, newTaskLimitsSchema, taskStateSchema, verificationConditionSchema,
  type TaskState, type Observation, type Action, type Target, type FixtureActionResult,
} from '@clickflow/shared';
import type { Confirmation, ReconciliationReport } from '@clickflow/shared';
import type { TaskStore } from '../state/task-store.js';
import { ModelError } from '../agent/errors.js';
import { completionInputSchema, planningInputSchema, type CompletionInput, type PlanningInput } from '../agent/planning-input.js';
import type { Planner } from '../agent/planner.js';
import type { RecoveryPlanner } from '../agent/recovery.js';
import { applyRecoveryPatch, PatchError } from './plan-patcher.js';
import type { CompletionAssessor } from '../agent/completion.js';
import { CompletionError, deterministicAssessment, evidenceCatalog, validateCompletion } from './completion-checker.js';

export class TaskError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const now = () => new Date().toISOString();
function ensure(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new TaskError(code, message); }
const terminal = new Set(['cancelled', 'completed', 'failed']);

/** Single process and one active task. Long model calls never hold the transition queue. */
export class TaskService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly planning = new Map<string, AbortController>();
  constructor(private readonly store: TaskStore, private readonly planner: Pick<Planner, 'generate'>, private readonly recovery?: Pick<RecoveryPlanner, 'update'>, private readonly completion?: Pick<CompletionAssessor, 'assess'>) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  private save(task: TaskState) {
    return this.store.save(taskStateSchema.parse({ ...task, revision: task.revision + 1, updatedAt: now() }), task.revision);
  }
  async get(id: string) {
    const task = await this.store.get(id);
    if (!task) throw new TaskError('NOT_FOUND', 'Task was not found.', 404);
    return task;
  }
  async getActive() {
    return (await this.store.list()).find((task) => !terminal.has(task.status)) ?? null;
  }
  async initialize() {
    for (const controller of this.planning.values()) controller.abort();
    // A restart cannot reissue unknown dispatches or silently restart a model call.
    for (const task of await this.store.list()) if (['planning', 'executing', 'recovering', 'awaiting_confirmation', 'waiting_for_page', 'waiting_for_model'].includes(task.status)) {
      await this.save({ ...task, status: 'paused', resumeRequired: true, planNeedsRecovery: task.planNeedsRecovery || task.status === 'recovering', planningRequestId: null, completionRequestId: null,
        errors: [...task.errors, { at: now(), code: 'INTERRUPTED', message: 'Backend restarted. Resume must refresh browser state and reconcile any prepared action. No dispatch was replayed.' }] });
    }
  }
  async create(id: string, rawInput: unknown, rawLimits?: unknown) {
    const input = planningInputSchema.parse(rawInput);
    const limits = newTaskLimitsSchema.parse(rawLimits ?? {});
    ensure(isSupportedPageUrl(input.observation.url), 'UNSUPPORTED_PAGE', 'Use a supported HTTP or HTTPS page without secrets in the URL.');
    const reserved = await this.serial(async () => {
      const existing = await this.store.get(id);
      if (existing) {
        ensure(existing.originalRequest === input.originalRequest, 'ID_REUSED', 'This request ID belongs to another goal.');
        ensure(rawLimits === undefined || isDeepStrictEqual(existing.limits, limits), 'ID_REUSED', 'A repeated creation request cannot change its execution limits.');
        return { task: existing, created: false };
      }
      ensure(!(await this.store.list()).some((task) => !terminal.has(task.status)), 'TASK_ACTIVE', 'Stop the current task before creating another.');
      const at = now();
      const task = await this.store.save(taskStateSchema.parse({ schemaVersion: 1, id, revision: 0, originalRequest: input.originalRequest,
        status: 'planning', initialContext: input.observation, currentContext: input.observation, plan: null, pendingAction: null,
        actionHistory: [], verificationResults: [], recoveryHistory: [], errors: [], retryCounts: {}, limits, modelCallCount: 1,
        cancellationRequested: false, createdAt: at, updatedAt: at, result: null, planningRequestId: randomUUID() }), null);
      return { task, created: true };
    });
    if (reserved.created) {
      const controller = new AbortController(); this.planning.set(id, controller);
      void this.generate(id, input, controller, reserved.task.planningRequestId!).finally(() => { if (this.planning.get(id) === controller) this.planning.delete(id); });
    }
    return reserved.task;
  }
  private async generate(id: string, input: PlanningInput, controller: AbortController, requestId: string) {
    try {
      const plan = await this.planner.generate({ ...input, constraints: [...input.constraints,
        'Supports observe, navigate, click, type, clear_input, select_option, scroll, press_key, wait, go_back, go_forward, extract_text and finish on explicitly permitted HTTP(S) sites. Navigation/history must verify an exact URL. Cross-origin transitions require human site access. Unknown button clicks, consequential operations and form submissions require explicit human confirmation. Never plan credentials, payment data, CAPTCHA or access-control bypass. Wait for typed predicates, never arbitrary sleeps. Extraction uses schemaId text-v1. Finish requests backend completion assessment against recorded evidence. Current targets use observed roles/names or labels; unseen targets remain semantic. Include the entire goal plan.'] }, controller.signal, () => this.chargeRetry(id));
      await this.serial(async () => {
        const task = await this.get(id);
        if (task.cancellationRequested || controller.signal.aborted || task.status !== 'planning' || task.planningRequestId !== requestId) return;
        await this.save({ ...task, status: 'ready', plan, planningRequestId: null, resumeRequired: false });
      });
    } catch (error) {
      await this.serial(async () => {
        const task = await this.get(id); if (task.cancellationRequested || task.status !== 'planning' || task.planningRequestId !== requestId) return;
        const safe = error instanceof ModelError ? error : new ModelError('INVALID_OUTPUT');
        await this.save({ ...task, status: 'failed', errors: [...task.errors, { at: now(), code: safe.code, message: safe.message }] });
      }).catch(() => undefined); // A failed disk write leaves the existing planning checkpoint intact.
    }
  }
  stop(id: string) {
    this.planning.get(id)?.abort();
    return this.serial(async () => {
      const task = await this.get(id); if (task.cancellationRequested || terminal.has(task.status)) return task;
      return this.save({ ...task, cancellationRequested: true, status: 'cancelled', planningRequestId: null, completionRequestId: null, resumeRequired: false });
    });
  }
  private chargeRetry(id: string) {
    return this.serial(async () => {
      const task = await this.get(id);
      if (task.cancellationRequested || task.modelCallCount >= task.limits.maxModelCalls || Date.now() - Date.parse(task.createdAt) >= task.limits.taskTimeoutMs) throw new ModelError('LIMIT_REACHED');
      await this.save({ ...task, modelCallCount: task.modelCallCount + 1 });
    });
  }
  assess(id: string, revision: number, requestId: string, rawContext: unknown) {
    return this.serial(async () => {
      const task = await this.get(id);
      if (task.completionRequestIds.includes(requestId)) return task;
      ensure(task.revision === revision, 'STALE_TASK', 'Refresh the checkpoint before assessing results.');
      ensure(task.plan && !task.pendingAction && !task.cancellationRequested && ['ready', 'paused'].includes(task.status), 'NOT_READY', 'Resolve any pending action or active operation before assessment.');
      ensure(!task.resumeRequired && !task.planNeedsRecovery, 'RESUME_REQUIRED', 'Resume or recover the changed checkpoint before assessment.');
      ensure(!task.actionHistory.some((entry) => entry.dispatchStatus === 'uncertain' && !task.reconciliationHistory.some((item) => item.actionId === entry.authorization.actionId && item.resolution === 'state_verified')), 'RECONCILIATION_REQUIRED', 'An uncertain effect cannot support completion.');
      ensure(Date.now() - Date.parse(task.createdAt) < task.limits.taskTimeoutMs && task.completionRequestIds.length < 100, 'LIMIT_REACHED', 'The task assessment or duration budget has expired.');
      const context = completionInputSchema.parse({ ...(rawContext as Record<string, unknown>), originalRequest: task.originalRequest });
      this.validateObservation(task, context.observation);
      const catalog = evidenceCatalog(task, context.goalChecks, context.observation);
      const deterministic = deterministicAssessment(task, catalog);
      ensure(deterministic || this.completion, 'ASSESSMENT_UNAVAILABLE', 'Completion assessment is not configured. Restart the updated backend.');
      ensure(deterministic || task.modelCallCount < task.limits.maxModelCalls, 'LIMIT_REACHED', 'The model-call budget is exhausted. Recorded results remain inspectable.');
      const snapshot = await this.save({ ...task, status: 'waiting_for_model', currentContext: context.observation,
        completionRequestId: requestId, completionRequestIds: [...task.completionRequestIds, requestId], modelCallCount: task.modelCallCount + (deterministic ? 0 : 1) });
      const controller = new AbortController(); this.planning.set(id, controller);
      void this.runAssessment(snapshot, context, controller, deterministic).finally(() => { if (this.planning.get(id) === controller) this.planning.delete(id); });
      return snapshot;
    });
  }
  private async runAssessment(snapshot: TaskState, context: CompletionInput, controller: AbortController, deterministic: ReturnType<typeof deterministicAssessment>) {
    const timeout = Math.min(snapshot.limits.modelTimeoutMs, snapshot.limits.taskTimeoutMs - (Date.now() - Date.parse(snapshot.createdAt)));
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
    try {
      const proposal = deterministic ?? await this.completion!.assess(snapshot, context, controller.signal, () => this.chargeRetry(snapshot.id));
      if (controller.signal.aborted) throw new ModelError('LIMIT_REACHED');
      await this.serial(async () => {
        const task = await this.get(snapshot.id);
        if (task.cancellationRequested || task.status !== 'waiting_for_model' || task.completionRequestId !== snapshot.completionRequestId || task.plan?.version !== snapshot.plan?.version) return;
        if (controller.signal.aborted || Date.now() - Date.parse(task.createdAt) >= task.limits.taskTimeoutMs || Date.now() - Date.parse(snapshot.updatedAt) >= timeout) throw new ModelError('LIMIT_REACHED');
        const result = validateCompletion(task, proposal, evidenceCatalog(task, context.goalChecks, context.observation));
        const complete = result.status === 'completed';
        const workResolved = task.plan!.steps.filter((step) => step.action.type !== 'finish').every((step) => ['completed', 'skipped'].includes(step.status));
        await this.save({ ...task, status: complete ? 'completed' : 'paused', completionRequestId: null, result,
          completionHistory: [...task.completionHistory, { requestId: snapshot.completionRequestId!, at: now(), planVersion: task.plan!.version, result }],
          plan: { ...task.plan!, version: task.plan!.version + 1, currentStepId: null, steps: task.plan!.steps.map((step) => step.action.type === 'finish' ? {
            ...step, status: complete ? 'completed' : workResolved ? 'blocked' : step.status, evidenceIds: complete ? result.evidence.map((entry) => entry.id) : [] } : step) } });
      });
    } catch (error) {
      await this.serial(async () => {
        const task = await this.get(snapshot.id);
        if (task.cancellationRequested || task.status !== 'waiting_for_model' || task.completionRequestId !== snapshot.completionRequestId || task.plan?.version !== snapshot.plan?.version) return;
        const safe = error instanceof CompletionError ? { code: 'UNSUPPORTED_COMPLETION', message: error.message } : error instanceof ModelError ? error : new ModelError('INVALID_OUTPUT');
        await this.save({ ...task, status: 'paused', completionRequestId: null, errors: [...task.errors, { at: now(), code: safe.code, message: safe.message }] });
      }).catch(() => undefined);
    } finally { clearTimeout(timer); }
  }
  recover(id: string, revision: number, requestId: string, rawContext: unknown) {
    return this.serial(async () => {
      const task = await this.get(id);
      if (task.recoveryRequestIds.includes(requestId)) return task;
      ensure(this.recovery, 'RECOVERY_UNAVAILABLE', 'Recovery is not configured.');
      ensure(task.revision === revision, 'STALE_TASK', 'Refresh the task before recovery.');
      ensure(task.plan && !task.pendingAction && !task.cancellationRequested && ['ready', 'paused'].includes(task.status), 'NOT_READY', 'An unresolved dispatch or active operation prevents recovery.');
      const last = task.actionHistory.at(-1);
      ensure(last?.dispatchStatus !== 'uncertain' || task.reconciliationHistory.some((entry) => entry.actionId === last.authorization.actionId && entry.resolution === 'state_verified'), 'RECONCILIATION_REQUIRED', 'The last dispatch is uncertain. Reconciliation is required before recovery.');
      ensure(task.recoveryAttemptCount < task.limits.maxRecoveries && task.modelCallCount < task.limits.maxModelCalls && task.actionHistory.length < task.limits.maxActions && Date.now() - Date.parse(task.createdAt) < task.limits.taskTimeoutMs, 'LIMIT_REACHED', 'Recovery, model, action or task-duration budget is exhausted.');
      const focus = task.plan.steps.find((step) => ['failed', 'blocked'].includes(step.status)) ?? task.plan.steps.find((step) => step.status === 'pending');
      ensure(focus && focus.action.type !== 'finish', 'ASSESSMENT_REQUIRED', 'Only completion assessment remains; it is not a recovery operation.');
      ensure((task.retryCounts[focus.logicalStepId] ?? 0) < task.limits.maxAttemptsPerStep, 'LIMIT_REACHED', 'This logical step has exhausted its attempt budget.');
      const context = planningInputSchema.parse({ ...(rawContext as Record<string, unknown>), originalRequest: task.originalRequest });
      const previous = task.currentContext ?? task.initialContext;
      ensure(previous && isSupportedPageUrl(context.observation.url) && previous.tabId === context.observation.tabId && previous.windowId === context.observation.windowId, 'DOCUMENT_CHANGED', 'Recovery requires fresh context from the original tab after explicit site access.');
      ensure(Math.abs(Date.now() - Date.parse(context.observation.capturedAt)) <= 30_000, 'STALE_OBSERVATION', 'Recovery needs fresh browser context.');
      const reserved = await this.save({ ...task, status: 'recovering', currentContext: context.observation, recoveryRequestIds: [...task.recoveryRequestIds, requestId], recoveryAttemptCount: task.recoveryAttemptCount + 1, modelCallCount: task.modelCallCount + 1 });
      const controller = new AbortController(); this.planning.set(id, controller);
      void this.runRecovery(reserved, context, controller).finally(() => { if (this.planning.get(id) === controller) this.planning.delete(id); });
      return reserved;
    });
  }
  private async runRecovery(snapshot: TaskState, context: PlanningInput, controller: AbortController) {
    const remaining = Math.max(1, snapshot.limits.taskTimeoutMs - (Date.now() - Date.parse(snapshot.createdAt)));
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const patch = await this.recovery!.update(snapshot, context, controller.signal, () => this.chargeRetry(snapshot.id));
      if (controller.signal.aborted) throw new ModelError('LIMIT_REACHED');
      await this.serial(async () => {
        const task = await this.get(snapshot.id);
        if (task.cancellationRequested || task.status !== 'recovering' || task.plan?.version !== snapshot.plan?.version || task.recoveryRequestIds.at(-1) !== snapshot.recoveryRequestIds.at(-1)) return;
        if (controller.signal.aborted) throw new ModelError('LIMIT_REACHED');
        const candidate = applyRecoveryPatch(task, patch);
        const executable = candidate.plan.steps.some((step) => step.status === 'pending' && step.dependencies.every((id) => candidate.plan.steps.some((parent) => parent.id === id && ['completed', 'skipped'].includes(parent.status))));
        await this.save({ ...task, status: executable ? 'ready' : 'paused', resumeRequired: false, planNeedsRecovery: false, plan: candidate.plan, recoveryHistory: [...task.recoveryHistory, { at: now(), patch: candidate.patch }] });
      });
    } catch (error) {
      await this.serial(async () => {
        const task = await this.get(snapshot.id); if (task.cancellationRequested || task.status !== 'recovering'
          || task.plan?.version !== snapshot.plan?.version || task.recoveryRequestIds.at(-1) !== snapshot.recoveryRequestIds.at(-1)) return;
        const safe = error instanceof PatchError ? error : error instanceof ModelError ? error : new ModelError('INVALID_OUTPUT');
        await this.save({ ...task, status: 'paused', errors: [...task.errors, { at: now(), code: safe.code, message: safe.message }] });
      }).catch(() => undefined);
    } finally { clearTimeout(timer); }
  }
  start(id: string, revision: number, observation: Observation) {
    return this.serial(async () => {
      const task = await this.get(id);
      ensure(task.revision === revision, 'STALE_TASK', 'Task changed. Refresh before starting.');
      ensure(!task.cancellationRequested && ['ready', 'paused'].includes(task.status) && task.plan && !task.pendingAction, 'NOT_READY', 'Task is not ready or an action outcome remains unresolved.');
      ensure(!task.resumeRequired && !task.planNeedsRecovery, 'RESUME_REQUIRED', 'Resume must refresh the browser checkpoint, or Recover plan must validate the changed page first.');
      const last = task.actionHistory.at(-1);
      ensure(last?.dispatchStatus !== 'uncertain' || task.reconciliationHistory.some((entry) => entry.actionId === last.authorization.actionId && entry.resolution === 'state_verified'), 'RECONCILIATION_REQUIRED', 'Reconcile the uncertain dispatch before scheduling any other action.');
      this.validateObservation(task, observation);
      return this.save({ ...task, status: 'executing', currentContext: observation });
    });
  }
  private validateObservation(task: TaskState, observation: Observation, navigationUrl?: string, referenceTime = Date.now()) {
    const initial = task.currentContext ?? task.initialContext;
    ensure(initial && isSupportedPageUrl(observation.url) && initial.tabId === observation.tabId && initial.windowId === observation.windowId && (navigationUrl ? observation.url === navigationUrl : initial.url === observation.url && initial.documentId === observation.documentId), 'DOCUMENT_CHANGED', 'The task document changed without matching navigation authorization. Stop and create a fresh plan.');
    const age = referenceTime - Date.parse(observation.capturedAt);
    ensure(age >= -5000 && age <= 30_000, 'STALE_OBSERVATION', 'A fresh observation is required before dispatch.');
  }
  private validateResumeObservation(task: TaskState, observation: Observation, allowTabRelink: boolean, expectedUrl?: string) {
    planningInputSchema.parse({ originalRequest: task.originalRequest, observation });
    const previous = task.currentContext ?? task.initialContext;
    ensure(previous && isSupportedPageUrl(observation.url), 'DOCUMENT_CHANGED', 'Resume needs a supported page with existing site access.');
    ensure(Math.abs(Date.now() - Date.parse(observation.capturedAt)) <= 30_000, 'STALE_OBSERVATION', 'Resume needs a fresh observation.');
    const sameTab = previous.tabId === observation.tabId && previous.windowId === observation.windowId;
    ensure(sameTab || (allowTabRelink && observation.url === (expectedUrl ?? previous.url)), 'TAB_RELINK_REQUIRED', 'Return to the original tab, or explicitly select Use this active tab with its exact expected URL.');
  }
  resume(id: string, revision: number, observation: Observation, allowTabRelink = false) {
    return this.serial(async () => {
      const task = await this.get(id);
      ensure(task.revision === revision, 'STALE_TASK', 'Refresh the checkpoint before resuming.');
      ensure(!task.cancellationRequested && !terminal.has(task.status), 'NOT_READY', 'A cancelled or terminal task cannot resume.');
      ensure(!task.pendingAction && !['planning', 'recovering', 'waiting_for_model'].includes(task.status), 'RECONCILIATION_REQUIRED', 'Wait for model work or reconcile the prepared action first.');
      const last = task.actionHistory.at(-1);
      ensure(last?.dispatchStatus !== 'uncertain' || task.reconciliationHistory.some((entry) => entry.actionId === last.authorization.actionId && entry.resolution === 'state_verified'), 'RECONCILIATION_REQUIRED', 'An uncertain dispatch cannot be repeated. Reconcile it or Stop this task.');
      this.validateResumeObservation(task, observation, allowTabRelink);
      ensure(Date.now() - Date.parse(task.createdAt) < task.limits.taskTimeoutMs, 'LIMIT_REACHED', 'The task duration budget has expired; resume does not reset safety limits.');
      const changedUrl = observation.url !== task.currentContext?.url;
      if (!task.plan) {
        ensure(!changedUrl, 'STALE_PLAN', 'Return to the original planning URL before resuming inference.');
        ensure(task.modelCallCount < task.limits.maxModelCalls && !task.actionHistory.length, 'LIMIT_REACHED', 'Planning cannot resume within its remaining budget.');
        const requestId = randomUUID();
        const saved = await this.save({ ...task, status: 'planning', initialContext: observation, currentContext: observation,
          planningRequestId: requestId, resumeRequired: false, modelCallCount: task.modelCallCount + 1 });
        const controller = new AbortController(); this.planning.set(id, controller);
        void this.generate(id, planningInputSchema.parse({ originalRequest: task.originalRequest, observation }), controller, requestId).finally(() => { if (this.planning.get(id) === controller) this.planning.delete(id); });
        return saved;
      }
      return this.save({ ...task, status: 'paused', currentContext: observation, resumeRequired: false,
        planNeedsRecovery: task.planNeedsRecovery || changedUrl });
    });
  }
  reconcile(id: string, revision: number, report: ReconciliationReport, allowTabRelink = false) {
    return this.serial(async () => {
      const task = await this.get(id);
      const duplicate = task.reconciliationHistory.find((entry) => entry.id === report.id);
      if (duplicate) { ensure(duplicate.actionId === report.actionId && duplicate.observationId === report.observation.id && duplicate.resolution === report.resolution, 'ID_REUSED', 'This reconciliation ID belongs to another report.'); return task; }
      const existing = task.actionHistory.find((entry) => entry.authorization.actionId === report.actionId);
      if (existing && task.reconciliationHistory.some((entry) => entry.actionId === report.actionId && entry.resolution !== 'unresolved')) return task;
      const pending = task.pendingAction;
      const authorization = pending?.authorization ?? (existing?.dispatchStatus === 'uncertain' ? existing.authorization : null);
      const condition = pending?.verification ?? existing?.verification?.condition;
      ensure(task.revision === revision && task.plan && authorization && authorization.actionId === report.actionId && authorization.leaseId === report.leaseId, 'STALE_TASK', 'The reconciliation no longer matches an unresolved action.');
      this.validateResumeObservation(task, report.observation, allowTabRelink, authorization.action.type === 'navigate' ? authorization.action.url : undefined);
      const claimed = task.dispatchClaims.some((entry) => entry.actionId === report.actionId && entry.leaseId === authorization.leaseId);
      if (report.resolution === 'not_dispatched') ensure(pending && !existing && !report.verification && (authorization.protocolVersion === 2 ? !claimed && ['prepared_journal', 'backend_prepared'].includes(report.source) : report.source === 'prepared_journal'), 'INVALID_RECONCILIATION', 'Dispatch must be unclaimed in protocol 2, or proven absent by the legacy local journal.');
      if (report.resolution === 'state_verified') {
        const verification = report.verification;
        ensure(!task.cancellationRequested && (authorization.protocolVersion === 1 || claimed) && condition && report.source === 'fresh_state' && canReconcileFromState(authorization.action, condition)
          && verification?.status === 'passed' && isDeepStrictEqual(verification.condition, condition), 'INVALID_RECONCILIATION', 'An unknown click or key cannot be resolved by a generic matching page condition.');
        ensure(verification.evidence.length > 0 && verification.evidence.every((evidence) => evidence.observationId === report.observation.id && evidence.sourceUrl === report.observation.url && evidence.capturedAt === report.observation.capturedAt)
          && Math.abs(Date.parse(verification.checkedAt) - Date.parse(report.observation.capturedAt)) < 5_000, 'INVALID_RECONCILIATION', 'Fresh verification evidence must match this exact observation.');
        if (authorization.requiresConfirmation || task.confirmations.some((entry) => entry.challenge.actionId === authorization.actionId)) ensure(task.confirmations.some((entry) => entry.challenge.actionId === authorization.actionId && entry.approvedAt), 'CONFIRMATION_REQUIRED', 'Reconciliation cannot invent prior human approval.');
      }
      const explanation = report.resolution === 'not_dispatched' ? 'The durable journal proves dispatch never began. The same step can be reviewed again; its attempt budget is preserved.'
        : report.resolution === 'state_verified' ? 'Fresh browser evidence verifies the exact desired state. The original dispatch remains uncertain and was not repeated.'
          : 'The original action may have occurred. It was not repeated. Inspect the website and Stop this task if a reliable outcome cannot be recovered.';
      const history = [...task.reconciliationHistory, { id: report.id, actionId: report.actionId, at: now(), observationId: report.observation.id, resolution: report.resolution, explanation }].slice(-200);
      if (report.resolution === 'unresolved') return this.save({ ...task, status: task.cancellationRequested ? 'cancelled' : 'paused', resumeRequired: true, reconciliationHistory: history });
      const outcome = { authorization, dispatchStatus: report.resolution === 'not_dispatched' ? 'not_dispatched' as const : 'uncertain' as const,
        recordedAt: now(), verification: report.verification, extraction: null, error: report.resolution === 'not_dispatched' ? { code: 'INTERRUPTED_BEFORE_DISPATCH', message: explanation } : null };
      const changedUrl = report.observation.url !== task.currentContext?.url && authorization.action.type !== 'navigate';
      return this.save({ ...task, status: task.cancellationRequested ? 'cancelled' : 'paused', pendingAction: null,
        currentContext: report.observation, resumeRequired: false, planNeedsRecovery: changedUrl || task.plan.steps.some((step) => step.id !== authorization.stepId && ['failed', 'blocked'].includes(step.status)), reconciliationHistory: history,
        actionHistory: existing ? task.actionHistory.map((entry) => entry.authorization.actionId === report.actionId ? outcome : entry) : [...task.actionHistory, outcome],
        verificationResults: report.verification ? [...task.verificationResults, report.verification] : task.verificationResults,
        plan: { ...task.plan, version: task.plan.version + 1, currentStepId: null, steps: task.plan.steps.map((step) => step.id === authorization.stepId ? { ...step,
          status: task.cancellationRequested ? 'failed' : report.resolution === 'not_dispatched' ? 'pending' : 'completed', evidenceIds: report.verification?.evidence.map((evidence) => evidence.id) ?? [] } : step) } });
    });
  }
  authorize(id: string, revision: number, actionId: string) {
    return this.serial(async () => {
      const task = await this.get(id);
      if (task.pendingAction?.authorization.actionId === actionId) return task;
      if (task.actionHistory.some((entry) => entry.authorization.actionId === actionId)) return task;
      try {
      ensure(task.revision === revision, 'STALE_TASK', 'Task changed. Refresh before authorizing.');
      ensure(!task.cancellationRequested && !task.resumeRequired && !task.planNeedsRecovery && task.status === 'executing' && task.plan && !task.pendingAction && task.currentContext, 'NOT_READY', 'No new action is permitted while an outcome is unresolved.');
      this.validateObservation(task, task.currentContext);
      const plan = task.plan;
      const step = plan.steps.find((entry) => entry.status === 'pending' && entry.dependencies.every((dependency) => plan.steps.some((other) => other.id === dependency && ['completed', 'skipped'].includes(other.status))));
      ensure(step, 'NO_EXECUTABLE_STEP', 'No executable pending step. Inspect failed or blocked dependencies.');
      if (step.action.type === 'navigate') ensure(isSupportedPageUrl(step.action.url), 'UNSUPPORTED_PAGE', 'Navigation needs a supported HTTP(S) URL.');
      ensure(task.actionHistory.length < task.limits.maxActions && Date.now() - Date.parse(task.createdAt) < task.limits.taskTimeoutMs, 'LIMIT_REACHED', 'The action or task duration limit was reached.');
      const attempt = (task.retryCounts[step.logicalStepId] ?? 0) + 1;
      ensure(attempt <= task.limits.maxAttemptsPerStep, 'LIMIT_REACHED', 'The step attempt limit was reached.');
      const action = this.remap(step.action, task.initialContext!, task.currentContext) as Action;
      const remainingMs = task.limits.taskTimeoutMs - (Date.now() - Date.parse(task.createdAt));
      ensure(remainingMs >= 100, 'LIMIT_REACHED', 'The remaining task duration cannot accommodate another action.');
      action.timeoutMs = Math.min(action.timeoutMs, task.limits.actionTimeoutMs, remainingMs);
      const verification = verificationConditionSchema.parse(this.remap(step.verification, task.initialContext!, task.currentContext));
      ensure(verification.type !== 'semantic_assessment_required' || action.type === 'finish', 'UNSUPPORTED_STEP', 'Semantic verification requires a later phase.');
      ensure(verification.type !== 'extracted_data_matches_schema' || verification.schemaId === 'text-v1', 'UNSUPPORTED_STEP', 'Unknown extraction schema.');
      if (['navigate', 'go_back', 'go_forward'].includes(action.type)) ensure(verification.type === 'url_matches' && verification.match === 'exact' && isSupportedPageUrl(verification.url), 'UNSUPPORTED_STEP', 'Navigation needs an exact supported URL verification.');
      for (const precondition of step.preconditions) {
        // Preconditions not provable from bounded observation must pause, never be assumed true.
        const resolved = verificationConditionSchema.parse(this.remap(precondition, task.initialContext!, task.currentContext));
        let satisfied = resolved.type === 'text_present' && !resolved.target && task.currentContext.visibleText.includes(resolved.text);
        if (resolved.type === 'element_visible') {
          const target = resolved.target;
          const matches = task.currentContext.elements.filter((element) => element.visible && (
            target.strategy === 'role' ? element.role === target.role && (target.exact ? element.name === target.name : element.name.includes(target.name)) :
            target.strategy === 'label' ? (target.exact ? element.label === target.label : element.label?.includes(target.label)) : false));
          satisfied = matches.length === 1;
        }
        ensure(satisfied, 'PRECONDITION_UNRESOLVED', 'A step precondition cannot be proven from the current observation.');
      }
      const version = plan.version + 1;
      const authorization = { taskId: id, planVersion: version, stepId: step.id, actionId, attempt, observationId: task.currentContext.id,
        leaseId: randomUUID(), leaseExpiresAt: new Date(Date.now() + action.timeoutMs + 15_000).toISOString(), action, requiresConfirmation: step.risk !== 'low', protocolVersion: 2 as const };
      return this.save({ ...task, pendingAction: { authorization, verification }, retryCounts: { ...task.retryCounts, [step.logicalStepId]: attempt },
        plan: { ...plan, version, currentStepId: step.id, steps: plan.steps.map((entry) => entry.id === step.id ? { ...entry, status: 'in_progress' } : entry) } });
      } catch (error) {
        if (error instanceof TaskError && task.status === 'executing' && !task.pendingAction && !task.cancellationRequested && task.revision === revision) await this.save({ ...task, status: 'paused', errors: [...task.errors, { at: now(), code: error.code, message: error.message }] });
        throw error;
      }
    });
  }
  claim(id: string, actionId: string, leaseId: string) {
    return this.serial(async () => {
      const task = await this.get(id); const authorization = task.pendingAction?.authorization;
      ensure(authorization && authorization.actionId === actionId && authorization.leaseId === leaseId, 'NO_AUTHORIZATION', 'No matching action is prepared.');
      ensure(!task.cancellationRequested && !task.resumeRequired && !task.planNeedsRecovery && task.status === 'executing' && Date.parse(authorization.leaseExpiresAt) > Date.now(), 'NOT_READY', 'A stopped, interrupted or expired action cannot claim dispatch.');
      const review = [...task.confirmations].reverse().find((entry) => entry.challenge.actionId === actionId);
      ensure((!authorization.requiresConfirmation && !review) || review?.approvedAt, 'CONFIRMATION_REQUIRED', 'Review this exact action before dispatch.');
      if (task.dispatchClaims.some((entry) => entry.actionId === actionId && entry.leaseId === leaseId)) return task;
      return this.save({ ...task, dispatchClaims: [...task.dispatchClaims, { actionId, leaseId, claimedAt: now() }] });
    });
  }
  review(id: string, revision: number, challenge: Confirmation, approve: boolean) {
    return this.serial(async () => {
      const task = await this.get(id); const pending = task.pendingAction;
      ensure(task.revision === revision && !task.cancellationRequested && pending && task.plan, 'STALE_TASK', 'Refresh before reviewing this action.');
      ensure(Date.now() - Date.parse(task.createdAt) < task.limits.taskTimeoutMs, 'LIMIT_REACHED', 'The task duration limit was reached during review.');
      ensure(['executing', 'awaiting_confirmation'].includes(task.status) && challenge.actionId === pending.authorization.actionId && challenge.observationId === pending.authorization.observationId
        && challenge.documentId === task.currentContext?.documentId && challenge.origin === new URL(task.currentContext.url).origin
        && Date.parse(challenge.expiresAt) > Date.now() && Date.parse(challenge.expiresAt) <= Date.now() + 125_000, 'APPROVAL_STALE', 'The action review no longer matches its browser context.');
      const existing = task.confirmations.find((entry) => entry.challenge.id === challenge.id);
      if (approve) ensure(existing && isDeepStrictEqual(existing.challenge, challenge) && !existing.approvedAt, 'APPROVAL_STALE', 'Review the exact current challenge first.');
      else ensure(!existing && Date.parse(pending.authorization.leaseExpiresAt) > Date.now(), 'APPROVAL_STALE', 'The authorization or review expired.');
      return this.save({ ...task, status: approve ? 'executing' : 'awaiting_confirmation',
        pendingAction: { ...pending, authorization: { ...pending.authorization, leaseExpiresAt: new Date(Date.parse(challenge.expiresAt) + pending.authorization.action.timeoutMs).toISOString() } },
        confirmations: approve ? task.confirmations.map((entry) => entry.challenge.id === challenge.id ? { ...entry, approvedAt: now() } : entry) : [...task.confirmations, { challenge, approvedAt: null }] });
    });
  }
  private remap(value: unknown, initial: Observation, current: Observation): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.remap(entry, initial, current));
    if (!value || typeof value !== 'object') return value;
    if ('strategy' in value) {
      const target = value as Target;
      ensure(target.strategy !== 'semantic', 'TARGET_UNRESOLVED', 'This semantic target needs fresh resolution in a later phase.');
      if (target.strategy === 'element_ref') {
        const old = initial.elements.find((entry) => entry.ref === target.ref && target.observationId === initial.id);
        const matches = current.elements.filter((entry) => old && entry.role === old.role && entry.name === old.name && entry.tagName === old.tagName && entry.inputType === old.inputType && entry.visible && entry.enabled);
        ensure(matches.length === 1 && matches[0], 'TARGET_UNRESOLVED', 'The original observed control cannot be resolved uniquely.');
        ensure(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'option', 'tab', 'menuitem', 'searchbox'].includes(matches[0].role) && !!matches[0].name, 'TARGET_UNRESOLVED', 'An observed control needs an accessible role/name before execution.');
        return { strategy: 'role', role: matches[0].role, name: matches[0].name, exact: true };
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.remap(child, initial, current)]));
  }
  outcome(id: string, result: FixtureActionResult) {
    return this.serial(async () => {
      const task = await this.get(id);
      const previous = task.actionHistory.find((entry) => entry.authorization.actionId === result.actionId);
      if (previous) return task; // The first accepted outcome is authoritative; replay does not mutate state.
      const pending = task.pendingAction;
      ensure(pending && task.plan && pending.authorization.actionId === result.actionId, 'NO_AUTHORIZATION', 'No matching prepared action exists.');
      ensure(result.actionType === pending.authorization.action.type, 'OUTCOME_MISMATCH', 'Action type does not match authorization.');
      if (result.dispatchStatus !== 'not_dispatched') {
        const review = [...task.confirmations].reverse().find((entry) => entry.challenge.actionId === result.actionId);
        ensure((!pending.authorization.requiresConfirmation && !review) || review?.approvedAt, 'CONFIRMATION_REQUIRED', 'Consequential execution requires a recorded human approval.');
        ensure(pending.authorization.protocolVersion === 1 || task.dispatchClaims.some((entry) => entry.actionId === result.actionId && entry.leaseId === pending.authorization.leaseId), 'NO_DISPATCH_CLAIM', 'Protocol 2 requires a durable backend dispatch claim before any browser effect.');
      }
      if (result.verification) ensure(isDeepStrictEqual(result.verification.condition, pending.verification), 'OUTCOME_MISMATCH', 'Verification predicate does not match authorization.');
      const navigationUrl = ['navigate', 'go_back', 'go_forward'].includes(pending.authorization.action.type) && pending.verification.type === 'url_matches' ? pending.verification.url : undefined;
      ensure(Date.parse(result.recordedAt) <= Date.now() + 5_000 && Date.parse(result.recordedAt) >= Date.parse(task.currentContext!.capturedAt) - 5_000, 'OUTCOME_MISMATCH', 'The recorded outcome time is outside its authorization context.');
      // A durable outbox may deliver an old, valid result after a long disconnect. Its evidence
      // must have been fresh at recording time; resume independently requires a NEW observation.
      if (result.observation) this.validateObservation(task, result.observation, navigationUrl, Date.parse(result.recordedAt));
      if (result.extraction) ensure(pending.authorization.action.type === 'extract_text' && result.extraction.outputKey === pending.authorization.action.outputKey && result.extraction.observationId === result.observation?.id && result.extraction.sourceUrl === result.observation.url && result.extraction.capturedAt === result.observation.capturedAt, 'OUTCOME_MISMATCH', 'Extraction must match the action and source observation.');
      if (result.verification?.status === 'passed' && pending.verification.type === 'extracted_data_matches_schema') ensure(result.extraction?.schemaId === pending.verification.schemaId && result.extraction.outputKey === pending.verification.outputKey, 'OUTCOME_MISMATCH', 'Passing extraction requires the requested record.');
      if (result.verification?.status === 'passed') {
        ensure(result.observation && result.verification.evidence.every((evidence) => evidence.observationId === result.observation!.id && evidence.sourceUrl === result.observation!.url), 'OUTCOME_MISMATCH', 'Verification evidence must refer to the resulting document observation.');
      }
      const passed = !task.cancellationRequested && result.dispatchStatus === 'dispatched' && !result.error && result.verification?.status === 'passed' && Date.parse(result.recordedAt) <= Date.parse(pending.authorization.leaseExpiresAt);
      const outcome = { authorization: pending.authorization, dispatchStatus: result.dispatchStatus, recordedAt: result.recordedAt, verification: result.verification, error: result.error, extraction: result.extraction };
      return this.save({ ...task, status: task.cancellationRequested ? 'cancelled' : 'paused', pendingAction: null, resumeRequired: result.dispatchStatus === 'uncertain',
        planNeedsRecovery: task.planNeedsRecovery || (!passed && pending.authorization.action.type !== 'finish' && !task.cancellationRequested),
        currentContext: result.observation ?? task.currentContext, actionHistory: [...task.actionHistory, outcome],
        verificationResults: result.verification ? [...task.verificationResults, result.verification] : task.verificationResults,
        errors: result.error ? [...task.errors, { at: now(), ...result.error }] : task.errors,
        plan: { ...task.plan, version: task.plan.version + 1, currentStepId: null, steps: task.plan.steps.map((step) => step.id === pending.authorization.stepId ? { ...step, status: pending.authorization.action.type === 'finish' ? 'blocked' : passed ? 'completed' : 'failed', evidenceIds: passed ? result.verification!.evidence.map((evidence) => evidence.id) : [] } : step) } });
    });
  }
}
