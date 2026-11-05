import { canReconcileFromState, fixtureActionResultSchema, isSupportedPageUrl } from '@clickflow/shared';
import type { Confirmation, ContentCommand, FixtureActionResult, ObservationFrame } from '@clickflow/shared';
import { BrowserToolError, safeError } from '../browser/errors.js';
import { PageObserver } from '../browser/observation.js';
import type { BrowserIdentity } from '../browser/observation.js';
import { actionReasons, assertSafeAction } from '../browser/policy.js';
import { resolveOne } from '../browser/targets.js';
import { assertSupportedVerification, evaluateVerification, waitForVerification } from '../browser/verifier.js';
import { accessibleName, safeVisibleText } from '../browser/dom.js';
import { setInput, pressKey } from '../browser/dom-actions.js';

export class ContentRuntime {
  private readonly observer = new PageObserver();
  private sessionId: string | null = null;
  private stopped = false;
  private running: { id: string; controller: AbortController; promise: Promise<FixtureActionResult> } | null = null;
  private readonly results = new Map<string, FixtureActionResult>();
  private readonly confirmations = new Map<string, Confirmation>();

  async cachedResult(sessionId: string, actionId: string): Promise<FixtureActionResult | null> {
    if (this.sessionId !== sessionId) return null;
    if (this.running?.id === actionId) return this.running.promise;
    return this.results.get(actionId) ?? null;
  }

  checkState(command: Extract<ContentCommand, { kind: 'content_check_state' }>) {
    const frame = this.observe({ ...command, kind: 'content_observe' });
    if (!canReconcileFromState(command.action, command.verification)) return { observation: frame.observation, verification: null };
    let passed: boolean;
    try {
      assertSupportedVerification(command.verification);
      passed = evaluateVerification(command.verification, this.observer, { scrollX, scrollY }) === true;
      this.observer.assertFresh(frame.observation.id, frame.observation.revision);
    } catch { return { observation: frame.observation, verification: null }; } // Missing, ambiguous or sensitive state is unresolved, never dispatch permission.
    return { observation: frame.observation, verification: {
      condition: command.verification, status: passed ? 'passed' as const : 'failed' as const, checkedAt: new Date().toISOString(),
      explanation: 'Fresh state was checked without executing the original action. Original dispatch remains unconfirmed.',
      evidence: passed ? [{ id: crypto.randomUUID(), observationId: frame.observation.id, sourceUrl: frame.observation.url,
        capturedAt: frame.observation.capturedAt, kind: 'dom' as const, summary: 'The exact idempotent assignment or navigation postcondition matches the fresh page.' }] : [],
    } };
  }
  checkCriteria(command: Extract<ContentCommand, { kind: 'content_check_criteria' }>) {
    if (this.running) throw new BrowserToolError('BUSY');
    const frame = this.observe({ ...command, kind: 'content_observe' });
    const goalChecks = command.criteria.map(({ criterionId, condition }) => {
      let status: 'passed' | 'failed' | 'unknown' = 'unknown';
      try {
        assertSupportedVerification(condition);
        const value = evaluateVerification(condition, this.observer, { scrollX, scrollY });
        status = value === true ? 'passed' : value === false ? 'failed' : 'unknown';
      } catch { /* Ambiguous, private and unsupported targets cannot become passing criteria. */ }
      return { criterionId, verification: { condition, status, checkedAt: new Date().toISOString(), explanation: 'Goal predicate checked on the fresh page without dispatching an action.',
        evidence: status === 'passed' ? [{ id: crypto.randomUUID(), observationId: frame.observation.id, capturedAt: frame.observation.capturedAt,
          sourceUrl: frame.observation.url, kind: 'dom' as const, summary: 'The original goal predicate matches the freshly observed page.' }] : [] } };
    });
    this.observer.assertFresh(frame.observation.id, frame.observation.revision);
    return { observation: frame.observation, goalChecks };
  }

  private async fingerprint(command: Extract<ContentCommand, { kind: 'content_execute' | 'content_prepare' }>, element?: HTMLElement): Promise<string> {
    // Values remain in the isolated world; only a digest leaves the browser. Include all form fields,
    // even properties changed without input events, and exact action parameters and DOM identity.
    const controls = element?.closest('form')?.querySelectorAll('input, textarea, select') ?? [];
    const snapshot = () => JSON.stringify({ action: command.action, verification: command.verification, session: command.sessionId,
      document: command.documentId, observation: command.expectedObservationId, revision: command.expectedRevision,
      url: location.href, target: element?.outerHTML.slice(0, 20_000),
      values: Array.from(controls, (control) => ({ name: control.getAttribute('name'), value: (control as HTMLInputElement).value })),
      value: element && 'value' in element ? element.value : null });
    const state = snapshot();
    if (state.length > 100_000) throw new BrowserToolError('POLICY_BLOCKED');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
    if (state !== snapshot()) throw new BrowserToolError('APPROVAL_STALE');
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async prepare(command: Extract<ContentCommand, { kind: 'content_prepare' }>): Promise<Confirmation | null> {
    if (this.stopped || this.sessionId !== command.sessionId || this.running) throw new BrowserToolError('STOPPED');
    this.observer.assertFresh(command.expectedObservationId, command.expectedRevision);
    const element = 'target' in command.action ? resolveOne(command.action.target, this.observer) : undefined;
    const reasons = actionReasons(command.action, element);
    if (command.forceConfirmation) reasons.push('The plan classifies this step as medium or high risk.');
    if (!reasons.length) return null;
    const fingerprint = await this.fingerprint(command, element);
    this.observer.assertFresh(command.expectedObservationId, command.expectedRevision);
    if (this.stopped) throw new BrowserToolError('STOPPED');
    const confirmation: Confirmation = { id: crypto.randomUUID(), actionId: command.actionId, observationId: command.expectedObservationId,
      documentId: command.documentId, origin: location.origin, fingerprint, reasons,
      summary: `${command.action.type} ${element ? accessibleName(element) : ''}`.trim().slice(0, 1000),
      expiresAt: new Date(Date.now() + 120_000).toISOString() };
    this.confirmations.clear(); this.confirmations.set(command.actionId, confirmation);
    return confirmation;
  }

  observe(identity: BrowserIdentity): ObservationFrame {
    if (identity.sessionId !== this.sessionId) {
      if (this.running) throw new BrowserToolError('BUSY');
      this.sessionId = identity.sessionId; this.stopped = false; this.results.clear(); this.confirmations.clear();
    }
    if (this.stopped) throw new BrowserToolError('STOPPED');
    return this.observer.observe(identity);
  }

  stop(sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    this.stopped = true;
    this.confirmations.clear();
    this.running?.controller.abort();
  }

  async execute(command: Extract<ContentCommand, { kind: 'content_execute' }>): Promise<FixtureActionResult> {
    if (command.sessionId !== this.sessionId || this.stopped) throw new BrowserToolError('STOPPED');
    const previous = this.results.get(command.actionId);
    if (previous) return previous;
    if (this.running) {
      if (this.running.id === command.actionId) return this.running.promise;
      throw new BrowserToolError('BUSY');
    }
    if (this.results.size >= 50) throw new BrowserToolError('ACTION_LIMIT');
    const controller = new AbortController();
    const promise = this.run(command, controller.signal);
    this.running = { id: command.actionId, controller, promise };
    try {
      const result = await promise;
      this.results.set(command.actionId, result);
      return result;
    } finally { this.running = null; }
  }

  private async run(command: Extract<ContentCommand, { kind: 'content_execute' }>, signal: AbortSignal): Promise<FixtureActionResult> {
    const actionType = command.action.type;
    if (['navigate', 'go_back', 'go_forward'].includes(actionType)) throw new BrowserToolError('UNSUPPORTED_ACTION');
    let dispatched = false;
    let extracted: { outputKey: string; text: string; schemaId: 'text-v1' } | undefined;
    const baseline = { scrollX, scrollY };
    const identity = { ...command, kind: 'content_observe' as const };
    try {
      if (!isSupportedPageUrl(location.href)) throw new BrowserToolError('UNSUPPORTED_PAGE');
      this.observer.assertFresh(command.expectedObservationId, command.expectedRevision);
      if (actionType !== 'finish') assertSupportedVerification(command.verification);
      const element = 'target' in command.action ? resolveOne(command.action.target, this.observer) : undefined;
      const confirmation = this.confirmations.get(command.actionId);
      let approved = false;
      if (confirmation || command.approval) {
        if (!confirmation || command.approval?.id !== confirmation.id || command.approval.fingerprint !== confirmation.fingerprint
          || Date.parse(confirmation.expiresAt) < Date.now() || await this.fingerprint(command, element) !== confirmation.fingerprint) throw new BrowserToolError('APPROVAL_STALE');
        this.observer.assertFresh(command.expectedObservationId, command.expectedRevision);
        approved = true; this.confirmations.delete(command.actionId);
      }
      assertSafeAction(command.action, element, approved);
      if (command.action.type === 'select_option' && element instanceof HTMLSelectElement) {
        const value = command.action.value;
        if (!Array.from(element.options).some((option) => option.value === value && !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled))) throw new BrowserToolError('TARGET_NOT_FOUND');
      }
      if (signal.aborted || this.stopped) throw new BrowserToolError('CANCELLED');
      // No await between final validation and the single synchronous DOM dispatch.
      if (command.action.type === 'click' && element) {
        dispatched = true;
        element.focus();
        element.click();
      } else {
        const action = command.action;
        dispatched = true;
        if (action.type === 'type' && element) setInput(element, action.text);
        else if (action.type === 'clear_input' && element) setInput(element, '');
        else if (action.type === 'select_option' && element instanceof HTMLSelectElement) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, action.value);
          element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (action.type === 'press_key' && element) pressKey(element, action);
        else if (action.type === 'scroll') window.scrollBy({ left: ['left', 'right'].includes(action.direction) ? action.pixels * (action.direction === 'left' ? -1 : 1) : 0, top: ['up', 'down'].includes(action.direction) ? action.pixels * (action.direction === 'up' ? -1 : 1) : 0, behavior: 'instant' });
        else if (action.type === 'extract_text' && element) extracted = { outputKey: action.outputKey, text: safeVisibleText(element, action.maxCharacters).text, schemaId: 'text-v1' };
      }
      const verdict = actionType === 'finish' ? { status: 'unknown' as const, explanation: 'Completion assessment requested. The backend must validate original goal criteria against recorded evidence.' } : await waitForVerification(command.verification, this.observer, signal, command.action.timeoutMs, { ...baseline, ...(extracted ? { extraction: extracted } : {}) });
      if (signal.aborted || this.stopped) throw new BrowserToolError('CANCELLED');
      const frame = this.observer.observe(identity);
      const now = new Date().toISOString();
      return fixtureActionResultSchema.parse({
        actionId: command.actionId, actionType, dispatchStatus: 'dispatched', recordedAt: now,
        verification: {
          ...verdict, condition: command.verification, checkedAt: now,
          evidence: verdict.status === 'passed' ? [{
            id: crypto.randomUUID(), observationId: frame.observation.id, capturedAt: frame.observation.capturedAt,
            sourceUrl: frame.observation.url, kind: 'dom', summary: 'The requested DOM verification predicate matched after dispatch.',
          }] : [],
        },
        observation: frame.observation,
        extraction: extracted && extracted.text ? { ...extracted, sourceUrl: frame.observation.url, capturedAt: frame.observation.capturedAt, observationId: frame.observation.id } : null,
        error: verdict.status === 'failed' ? safeError(new BrowserToolError('VERIFICATION_TIMEOUT')) : null,
      });
    } catch (error) {
      return fixtureActionResultSchema.parse({
        actionId: command.actionId, actionType,
        dispatchStatus: dispatched ? 'dispatched' : 'not_dispatched', recordedAt: new Date().toISOString(),
        verification: null, observation: null, error: safeError(error),
      });
    }
  }
}
