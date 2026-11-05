import { useEffect, useRef, useState } from 'react';
import { browserToolResponseSchema, containsSensitiveText, DEFAULT_PREFERENCES, durableExecutionSchema, needsFreshGoalCheck, taskCheckpointSchema, taskExecutionCommandSchema, type Confirmation, type DurableExecution, type FixtureSession, type GoalCheck, type Preferences, type TaskState } from '@clickflow/shared';
import { browserTool, hasExtensionRuntime } from '../services/browser-tools.js';
import { activeTask, TaskApiError, taskEvent, taskRequest } from '../services/tasks.js';
import { pairBackend, revokePairing } from '../services/pairing.js';
import { taskControl } from '../services/task-control.js';
import { ActivityLog, LiveExecution, TaskResults } from './TaskResults.js';

export function TaskRunner({ preferences = DEFAULT_PREFERENCES, preferencesReady = true, onPreferencesChange }: { preferences?: Preferences; preferencesReady?: boolean; onPreferencesChange?: (next: Preferences) => void }) {
  const installed = hasExtensionRuntime();
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [request, setRequest] = useState('');
  const [task, setTask] = useState<TaskState | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(installed);
  const [error, setError] = useState<string | null>(null);
  const capture = preferences.screenshots;
  const [review, setReview] = useState<{ challenge: Confirmation; sessionId: string } | null>(null);
  const [knownTaskId, setKnownTaskId] = useState<string | null>(null);
  const [needsResume, setNeedsResume] = useState(false);
  const [offline, setOffline] = useState(false);
  const [allowTabRelink, setAllowTabRelink] = useState(false);
  const [journal, setJournal] = useState<DurableExecution | null>(null);
  const journalRef = useRef<DurableExecution | null>(null);
  const taskRef = useRef<TaskState | null>(null);
  const expectedTaskId = useRef<string | null>(null);
  const sessionRef = useRef<FixtureSession | null>(null);
  const stopped = useRef(false);
  const operation = useRef(false);
  const controller = useRef<AbortController | null>(null);
  function accept(next: TaskState, persist = true) {
    if (expectedTaskId.current && expectedTaskId.current !== next.id) return;
    expectedTaskId.current = next.id;
    const current = taskRef.current;
    if (current?.id === next.id && current.revision >= next.revision) return;
    taskRef.current = next; setTask(next);
    setKnownTaskId(next.id);
    if (persist && installed) void taskControl({ kind: 'persist_task_checkpoint', task: next }).catch(() => setNeedsResume(true));
  }
  function acceptJournal(value: unknown) {
    const parsed = durableExecutionSchema.safeParse(value);
    if (parsed.success) { journalRef.current = parsed.data; setJournal(parsed.data); }
  }
  async function selectTask(next: TaskState) {
    expectedTaskId.current = next.id;
    if (taskRef.current?.id !== next.id) { taskRef.current = null; setTask(null); }
    setKnownTaskId(next.id); setNeedsResume(true); setOffline(false);
    await chrome.storage.local.set({ clickflowTaskId: next.id });
    accept(next);
  }
  function connectionFailure(failure: unknown) {
    setOffline(failure instanceof TaskApiError && failure.code === 'BACKEND_OFFLINE');
    if (failure instanceof TaskApiError && failure.code === 'UNAUTHORIZED') setSaved(false);
    setError(failure instanceof Error ? failure.message : 'Unable to load the task checkpoint.');
  }
  async function findActive(authToken: string, missingId?: string, signal?: AbortSignal) {
    const current = await activeTask(authToken, signal);
    if (signal?.aborted || missingId && expectedTaskId.current !== missingId) return current;
    setOffline(false);
    if (current) {
      await selectTask(current);
      setError('An unfinished backend task was restored. Review its original task below, then choose Resume task or Stop task before creating another.');
    } else if (missingId) {
      // Only forget a selection proven absent on the backend. Never discard action journals or Stop intents.
      expectedTaskId.current = null; taskRef.current = null; setTask(null); setKnownTaskId(null); setNeedsResume(false); setOffline(false);
      await chrome.storage.local.remove(['clickflowTaskId', 'clickflowTaskCheckpoint']);
      setError('The previous request was not created. You can generate a new plan.');
    }
    return current;
  }
  useEffect(() => {
    if (!installed) return;
    let disposed = false;
    const restore = new AbortController();
    void chrome.storage.local.get(['clickflowAccessToken', 'clickflowTaskId', 'clickflowTaskCheckpoint', 'clickflowExecutionJournal', 'clickflowTaskDraft']).then(async (stored) => {
      if (disposed) return;
      acceptJournal(stored.clickflowExecutionJournal);
      if (typeof stored.clickflowTaskDraft === 'string' && !containsSensitiveText(stored.clickflowTaskDraft)) setRequest(stored.clickflowTaskDraft.slice(0, 4000));
      if (typeof stored.clickflowTaskId === 'string') { setKnownTaskId(stored.clickflowTaskId); expectedTaskId.current = stored.clickflowTaskId; setNeedsResume(true); }
      const checkpoint = taskCheckpointSchema.safeParse(stored.clickflowTaskCheckpoint);
      if (checkpoint.success && checkpoint.data.task.id === stored.clickflowTaskId) accept(checkpoint.data.task, false);
      if (typeof stored.clickflowAccessToken === 'string') {
        setToken(stored.clickflowAccessToken); setSaved(true);
        try {
          if (typeof stored.clickflowTaskId === 'string') {
            try { const current = await taskRequest(`/${stored.clickflowTaskId}`, stored.clickflowAccessToken, undefined, restore.signal); if (!disposed) accept(current); }
            catch (failure) { if (failure instanceof TaskApiError && failure.code === 'NOT_FOUND') await findActive(stored.clickflowAccessToken, stored.clickflowTaskId, restore.signal); else throw failure; }
          } else await findActive(stored.clickflowAccessToken, undefined, restore.signal);
        } catch (failure) { if (!disposed) connectionFailure(failure); }
      }
    }).catch((failure: unknown) => { if (!disposed) connectionFailure(failure); }).finally(() => { if (!disposed) setRestoring(false); });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || disposed) return;
      if (changes.clickflowExecutionJournal) acceptJournal(changes.clickflowExecutionJournal.newValue);
      const parsed = taskCheckpointSchema.safeParse(changes.clickflowTaskCheckpoint?.newValue);
      if (parsed.success) accept(parsed.data.task, false);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { disposed = true; restore.abort(); stopped.current = true; controller.current?.abort(); chrome.storage.onChanged.removeListener(changed); };
  }, [installed]);
  useEffect(() => {
    const id = task?.id ?? knownTaskId;
    if (!id || !token || !installed) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function poll() {
      try {
        const next = await taskEvent(id!, taskRef.current?.revision ?? -1, token, abort.signal);
        if (next && !abort.signal.aborted) accept(next);
        if (!abort.signal.aborted) {
          failures = 0; setOffline(false);
          const local = journalRef.current;
          if (local?.cancellations.some((entry) => !entry.acknowledged) || local?.active && ['outcome_ready', 'reconciliation_ready'].includes(local.active.phase)) {
            const synchronized = await taskControl({ kind: 'sync_task', taskId: id!, resume: false, allowTabRelink: false });
            if (!abort.signal.aborted && synchronized.task) accept(synchronized.task);
          }
        }
      } catch (failure) {
        if (!abort.signal.aborted && expectedTaskId.current === id) {
          failures++; setNeedsResume(true);
          if (failure instanceof TaskApiError && failure.code === 'NOT_FOUND') {
            // A create response can still be in flight. Do not erase its reserved ID underneath it.
            if (!operation.current) {
              try { await findActive(token, id!, abort.signal); } catch (lookupFailure) { if (!abort.signal.aborted) connectionFailure(lookupFailure); }
            }
          } else connectionFailure(failure);
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    }
    timer = setTimeout(() => void poll(), 100);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [task?.id, knownTaskId, token, installed]);
  async function saveToken() {
    await perform(async () => {
      const paired = await pairBackend(token);
      await chrome.storage.local.set({ clickflowAccessToken: paired }); setToken(paired); setSaved(true);
      await findActive(paired);
    });
  }
  async function boundObservation() {
    let state = await browserTool({ kind: 'get_fixture_state' });
    if (!state.ok) throw new Error(state.error.message);
    if (!state.session || state.session.stopped) state = await browserTool({ kind: 'bind_fixture' });
    if (!state.ok) throw new Error(state.error.message);
    if (!state.session || state.session.stopped) throw new Error('No active page binding. In Website access, choose Allow current site or Bind allowed site. Keep that webpage tab active, then retry Generate plan.');
    sessionRef.current = state.session;
    const observed = await browserTool({ kind: 'observe_fixture', sessionId: state.session.id, screenshot: capture });
    if (!observed.ok || !observed.session) throw new Error(observed.ok ? 'Page unavailable.' : observed.error.message);
    sessionRef.current = observed.session;
    return observed;
  }
  async function perform(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; stopped.current = false; setBusy(true); setError(null); controller.current = new AbortController();
    try { await work(); } catch (failure) {
      if (taskRef.current?.pendingAction) setNeedsResume(true);
      if (!stopped.current) {
        if (failure instanceof TaskApiError) connectionFailure(failure);
        else setError(failure instanceof Error ? failure.message : 'Task failed. Refresh before continuing.');
      }
    } finally { operation.current = false; setBusy(false); }
  }
  async function generate() {
    await perform(async () => {
      if (containsSensitiveText(request)) throw new Error('Remove credentials, email addresses, payment details or other private information from the task before sending it to the model.');
      if (knownTaskId && journalRef.current?.cancellations.some((entry) => !entry.acknowledged)) {
        const prior = await taskControl({ kind: 'sync_task', taskId: knownTaskId, resume: false, allowTabRelink: false });
        if (prior.journal) acceptJournal(prior.journal);
        if (!prior.ok && prior.error?.code !== 'NOT_FOUND') throw new Error(prior.error?.message ?? 'Reconnect to deliver the saved Stop before creating another task.');
        if (stopped.current) return;
      }
      // Check before replacing the selection: a rejected create must not strand the real active task.
      if (await findActive(token, undefined, controller.current!.signal) || stopped.current) return;
      const observed = await boundObservation(); if (stopped.current) return;
      const id = crypto.randomUUID();
      expectedTaskId.current = id; taskRef.current = null; setTask(null); setKnownTaskId(id); setNeedsResume(false);
      // Remember the request ID before sending: a lost response must not create a second task/model call.
      await chrome.storage.local.set({ clickflowTaskId: id });
      let next: TaskState;
      try {
        next = await taskRequest('', token, { taskId: id, limits: preferences.limits, input: { originalRequest: request, observation: observed.session!.observation,
          ...(observed.screenshotDataUrl ? { screenshot: { id: observed.session!.observation.screenshot.status === 'captured' ? observed.session!.observation.screenshot.id : '', dataUrl: observed.screenshotDataUrl } } : {}) } }, controller.current!.signal);
      } catch (failure) {
        // Another panel can create between lookup and POST. Restore its checkpoint without cancelling it.
        if (failure instanceof TaskApiError && failure.code === 'TASK_ACTIVE') { await findActive(token, id, controller.current!.signal); return; }
        throw failure;
      }
      accept(next);
      if (stopped.current) accept(await taskRequest(`/${id}/stop`, token, {}));
    });
  }
  async function start() {
    await perform(async () => {
      try {
      const current = taskRef.current; if (!current) return;
      const observed = await boundObservation(); if (stopped.current) return;
      let next = await taskRequest(`/${current.id}/start`, token, { expectedRevision: current.revision, observation: observed.session!.observation }, controller.current!.signal);
      accept(next); if (stopped.current) return;
      next = await taskRequest(`/${current.id}/authorize`, token, { expectedRevision: next.revision, actionId: crypto.randomUUID() }, controller.current!.signal);
      accept(next); if (stopped.current || !next.pendingAction) return;
      const prepared = next.pendingAction;
      const durable = await taskControl({ kind: 'checkpoint_task_action', sessionId: observed.session!.id, ...prepared });
      if (!durable.ok) throw new Error(durable.error?.message ?? 'The action could not be checkpointed.');
      if (stopped.current) return;
      const preview = await browserTool({ kind: 'prepare_action', sessionId: observed.session!.id, actionId: prepared.authorization.actionId,
        action: prepared.authorization.action, verification: prepared.verification, forceConfirmation: prepared.authorization.requiresConfirmation });
      if (stopped.current) return;
      if (!preview.ok) {
        const recorded = await taskControl({ kind: 'record_preflight_failure', taskId: current.id, actionId: prepared.authorization.actionId, error: preview.error });
        if (recorded.task) accept(recorded.task);
        if (!recorded.ok) throw new Error(recorded.error?.message ?? 'The preflight outcome is retained locally. Reconnect before continuing.');
        if (['TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS', 'TARGET_DISABLED', 'STALE_OBSERVATION'].includes(preview.error.code)) { await requestRecovery(); return; }
        throw new Error(preview.error.message);
      }
      if (preview.confirmation) {
        next = await taskRequest(`/${current.id}/review`, token, { expectedRevision: next.revision, challenge: preview.confirmation, approve: false });
        accept(next); if (!stopped.current) setReview({ challenge: preview.confirmation, sessionId: observed.session!.id });
        return;
      }
      await dispatch(next, observed.session!.id);
      } catch (failure) {
        if (!stopped.current && failure instanceof TaskApiError && ['TARGET_UNRESOLVED', 'PRECONDITION_UNRESOLVED', 'DOCUMENT_CHANGED', 'STALE_OBSERVATION'].includes(failure.code)) await requestRecovery();
        else throw failure;
      }
    });
  }
  async function dispatch(current: TaskState, sessionId: string, challenge?: Confirmation) {
    const prepared = current.pendingAction; if (!prepared || stopped.current) return;
    const command = taskExecutionCommandSchema.parse({ kind: 'execute_task_action', sessionId, ...prepared,
      ...(challenge ? { approval: { id: challenge.id, fingerprint: challenge.fingerprint } } : {}) });
    const response = browserToolResponseSchema.parse(await chrome.runtime.sendMessage(command));
    const result = response.session?.lastResult;
    if (!response.ok || !result || result.actionId !== prepared.authorization.actionId) throw new Error(response.ok ? 'Dispatch outcome is uncertain. It will not be repeated.' : response.error.message);
    const synchronized = await taskControl({ kind: 'sync_task', taskId: current.id, resume: false, allowTabRelink: false });
    if (synchronized.task) accept(synchronized.task);
    if (!synchronized.ok || !synchronized.task || !synchronized.task.actionHistory.some((entry) => entry.authorization.actionId === result.actionId)) { setNeedsResume(true); throw new Error('The browser outcome is saved locally. Resume reconnects and delivers it without repeating the action.'); }
    const checkpoint = synchronized.task;
    if (!stopped.current && !checkpoint.cancellationRequested && result.actionType === 'finish' && result.dispatchStatus === 'dispatched' && !result.error) { await requestAssessment(); return; }
    if (!stopped.current && !checkpoint.cancellationRequested && result.dispatchStatus !== 'uncertain'
      && (result.dispatchStatus === 'not_dispatched' || result.verification?.status === 'failed')
      && !['APPROVAL_STALE', 'POLICY_BLOCKED', 'PERMISSION_REQUIRED', 'STOPPED'].includes(result.error?.code ?? '')) await requestRecovery();
  }
  async function approve() {
    await perform(async () => {
      const current = taskRef.current; if (!current || !review) return;
      const next = await taskRequest(`/${current.id}/review`, token, { expectedRevision: current.revision, challenge: review.challenge, approve: true });
      accept(next); if (stopped.current) return;
      const approved = review; setReview(null);
      await dispatch(next, approved.sessionId, approved.challenge);
    });
  }
  async function requestRecovery() {
    const current = taskRef.current; if (!current || stopped.current) return;
    const observed = await boundObservation(); if (stopped.current) return;
    const latest = await taskRequest(`/${current.id}`, token); accept(latest);
    if (stopped.current) return;
    const observation = observed.session!.observation;
    const next = await taskRequest(`/${current.id}/recover`, token, { expectedRevision: latest.revision, requestId: crypto.randomUUID(), context: { observation,
      ...(observed.screenshotDataUrl && observation.screenshot.status === 'captured' ? { screenshot: { id: observation.screenshot.id, dataUrl: observed.screenshotDataUrl } } : {}) } });
    accept(next);
    if (stopped.current) accept(await taskRequest(`/${current.id}/stop`, token, {}));
  }
  async function requestAssessment() {
    const current = taskRef.current; if (!current || stopped.current) return;
    const observed = await boundObservation(); if (stopped.current) return;
    const latest = await taskRequest(`/${current.id}`, token); accept(latest);
    if (stopped.current) return;
    let observation = observed.session!.observation;
    let goalChecks: GoalCheck[] = [];
    const criteria = latest.plan!.goalCriteria.flatMap((criterion) => criterion.verification && needsFreshGoalCheck(criterion.verification) ? [{ criterionId: criterion.id, condition: criterion.verification }] : []);
    if (criteria.length) {
      const checked = await browserTool({ kind: 'check_goal_criteria', sessionId: observed.session!.id, criteria });
      if (!checked.ok || !checked.session || !checked.goalChecks) throw new Error(checked.ok ? 'Fresh goal checks were unavailable.' : checked.error.message);
      sessionRef.current = checked.session; observation = checked.session.observation; goalChecks = checked.goalChecks;
    }
    if (stopped.current) return;
    const next = await taskRequest(`/${current.id}/assess`, token, { expectedRevision: latest.revision, requestId: crypto.randomUUID(), context: { observation, goalChecks,
      ...(!criteria.length && observed.screenshotDataUrl && observation.screenshot.status === 'captured' ? { screenshot: { id: observation.screenshot.id, dataUrl: observed.screenshotDataUrl } } : {}) } }, controller.current!.signal);
    accept(next);
    if (stopped.current) accept(await taskRequest(`/${current.id}/stop`, token, {}));
  }
  async function stop() {
    stopped.current = true;
    controller.current?.abort();
    setReview(null);
    const current = taskRef.current;
    const id = current?.id ?? expectedTaskId.current;
    // Stop the browser immediately; backend cancellation is independent of the local request.
    const state = sessionRef.current;
    const local = state ? browserTool({ kind: 'stop_fixture', sessionId: state.id }) : browserTool({ kind: 'get_fixture_state' }).then((response) => response.session ? browserTool({ kind: 'stop_fixture', sessionId: response.session.id }) : undefined);
    try {
      const results = await Promise.all([local, id ? taskControl({ kind: 'stop_task', taskId: id }) : Promise.resolve(null)]);
      const result = results[1];
      if (result?.task) accept(result.task);
      if (result?.journal) acceptJournal(result.journal);
      if (result && (!result.ok || result.journal?.cancellations.some((entry) => entry.taskId === id && !entry.acknowledged))) setError('Stopped locally. Backend cancellation is saved and will be delivered when the connection returns.');
    } catch { setError('Local Stop was requested. Backend is unavailable; refresh before continuing.'); }
  }
  async function resume() {
    await perform(async () => {
      const id = taskRef.current?.id ?? knownTaskId; if (!id) return;
      setReview(null);
      const response = await taskControl({ kind: 'sync_task', taskId: id, resume: true, allowTabRelink });
      if (response.task) accept(response.task);
      if (response.journal) acceptJournal(response.journal);
      if (response.browser?.session) sessionRef.current = response.browser.session;
      setNeedsResume(!response.ok || !!response.task?.resumeRequired);
      if (response.error) throw new Error(response.error.message);
      setOffline(false);
    });
  }
  const pendingCancellation = journal?.cancellations.some((entry) => entry.taskId === (task?.id ?? knownTaskId) && !entry.acknowledged) ?? false;
  const resumeAction = task?.pendingAction?.authorization.action ?? (task?.actionHistory.at(-1)?.dispatchStatus === 'uncertain' ? task.actionHistory.at(-1)?.authorization.action : undefined);
  const resumeUrl = resumeAction?.type === 'navigate' ? resumeAction.url : task?.currentContext?.url;
  const active = task && !['cancelled', 'failed', 'completed'].includes(task.status);
  const completed = task?.plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  return <section className="composer task-runner" aria-labelledby="task-heading">
    <h2 id="task-heading">Your task</h2>
    {!installed ? <p className="helper-copy">Load the unpacked extension to generate a plan from a permitted active page.</p> : <>
      <details className="connection-details mb-3" open={!saved}><summary>Local backend connection</summary>
        <p className="helper-copy">Paste the local token from <code>.data/extension-token</code> in the ClickFlow folder. This is separate from your model API key.</p>
        <label className="field-label" htmlFor="backend-token">Local connection token</label>
        <input id="backend-token" type="password" autoComplete="off" className="tool-input" value={token} onChange={(event) => { setToken(event.target.value); setSaved(false); }} />
        <button className="secondary-button mt-2" disabled={token.trim().length !== 64 || busy} onClick={() => void saveToken()}>Save connection</button>
        <button className="text-button" disabled={!saved || busy || !!active} onClick={() => void perform(async () => { await revokePairing(token); await chrome.storage.local.remove('clickflowAccessToken'); setToken(''); setSaved(false); })}>Disconnect backend</button>
      </details>
      <label htmlFor="task" className="field-label">What would you like to do?</label>
      <textarea id="task" rows={3} maxLength={4000} value={request} disabled={busy || !!active} onChange={(event) => { const value = event.target.value; setRequest(value); if (containsSensitiveText(value)) void chrome.storage.local.remove('clickflowTaskDraft'); else void chrome.storage.local.set({ clickflowTaskDraft: value }); }} placeholder="Focus the Search field on this test page." />
      <label className="tool-checkbox"><input type="checkbox" checked={capture} disabled={busy || !!active} onChange={(event) => onPreferencesChange?.({ ...preferences, screenshots: event.target.checked })} /> Include a screenshot when safe</label>
      <p className="helper-copy">Generate sends your task and bounded, sanitized page context to the configured model. Keep private information out of the task. Review the full plan before Start. Each Start runs one step; website controls with possible side effects require a separate approval.</p>
      {review ? <div className="confirmation-card" role="region" aria-label="Action confirmation"><h3>Confirm this action</h3><p className="site-origin">{review.challenge.origin}</p><p>{review.challenge.summary}</p><ul>{review.challenge.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><pre>{JSON.stringify(task?.pendingAction?.authorization.action, null, 2)}</pre><p className="helper-copy">Approval expires in two minutes and becomes invalid if the page, target or form changes. Stop cancels this review.</p><div className="tool-buttons"><button className="primary-button" disabled={busy} onClick={() => void approve()}>Approve this action</button><button className="stop-button" onClick={() => void stop()}>Decline and stop</button></div></div> : null}
      <div className="tool-buttons task-controls">
        <button className="primary-button" disabled={!preferencesReady || restoring || !saved || !request.trim() || busy || !!active} onClick={() => void generate()}>Generate plan</button>
        <button className="secondary-button" disabled={busy || needsResume || offline || pendingCancellation || task?.resumeRequired || task?.planNeedsRecovery || !task?.plan || !['ready', 'paused'].includes(task.status) || !!task.pendingAction || task.cancellationRequested} onClick={() => void start()}>Start next step</button>
        <button className="stop-button" disabled={!active && !busy && (!knownTaskId || !!task)} onClick={() => void stop()}>Stop task</button>
        <button className="secondary-button" disabled={busy || !knownTaskId || !!task?.cancellationRequested || task?.status === 'completed' || task?.status === 'failed'} onClick={() => void resume()}>Resume task</button>
        <button className="secondary-button" disabled={busy || !task?.plan || !['ready', 'paused'].includes(task.status) || !!task.pendingAction || task.cancellationRequested} onClick={() => void perform(requestRecovery)}>Recover plan</button>
        <button className="secondary-button" disabled={busy || needsResume || offline || !task?.plan || !['ready', 'paused'].includes(task.status) || !!task.pendingAction || task.cancellationRequested || task.resumeRequired || task.planNeedsRecovery} onClick={() => void perform(requestAssessment)}>Assess results</button>
        {task ? <button className="text-button" onClick={() => void taskRequest(`/${task.id}`, token).then(accept, () => setError('Unable to refresh task.'))}>Refresh task</button> : null}
      </div>
      {restoring ? <p role="status" className="helper-copy">Checking the saved task with the backend…</p> : null}
      {knownTaskId ? <div className="resume-checkpoint" aria-live="polite"><p>{offline ? task ? 'Offline checkpoint · no new dispatch is permitted.' : 'Backend unavailable · waiting to locate the saved request.' : pendingCancellation ? 'Stop saved locally · backend cancellation pending.' : needsResume || task?.resumeRequired ? 'Execution checkpoint · Resume observes and reconciles before Start.' : 'Checkpoint connected'}</p>
        {resumeUrl ? <p className="helper-copy">Expected page: {resumeUrl}</p> : null}
        {task && !task.plan && task.status === 'paused' ? <p className="helper-copy">Initial planning was interrupted. Resume sends fresh context from the original page to the configured model and uses the remaining planning budget.</p> : null}
        <label className="tool-checkbox"><input type="checkbox" checked={allowTabRelink} disabled={busy} onChange={(event) => setAllowTabRelink(event.target.checked)} /> Use this active tab if the original tab no longer exists</label>
        <p className="helper-copy">Relinking requires its exact expected URL and existing site access. Resume never replays a click. If an uncertain side effect cannot be established, inspect the website and Stop this task.</p>
        {task?.planNeedsRecovery ? <p className="tool-error">The page or an interrupted model update invalidated the checkpoint. Review a fresh Recover plan before Start.</p> : null}
        {journal?.active?.command.authorization.taskId === knownTaskId ? <p className="helper-copy">Local action checkpoint: {journal.active.phase.replaceAll('_', ' ')}{journal.active.result ? ` · ${journal.active.result.dispatchStatus}` : ''}</p> : null}
        {journal?.lastError ? <p className="helper-copy">Connection: {journal.lastError.message}</p> : null}
      </div> : null}
      {task ? <div className="task-state" aria-live="polite"><strong>{task.status.replaceAll('_', ' ')} · revision {task.revision}</strong>
        <p className="helper-copy">Original task: {task.originalRequest}</p>
        <LiveExecution task={task} />
        <TaskResults task={task} />
        <p>{completed} of {task.plan?.steps.length ?? 0} steps verified{task.plan ? ` · plan v${task.plan.version}` : task.status === 'planning' ? ' · generating the complete plan' : ' · no plan available'}</p>
        {task.pendingAction ? <p className="helper-copy">Action {task.pendingAction.authorization.actionId}: prepared; awaiting its outcome. A second action is blocked.</p> : null}
        {task.status === 'paused' ? <p className="helper-copy">Paused for inspection. Start executes one validated step. Resume reconciles interruptions; Recover plan uses fresh context. Assess results checks original criteria without performing browser actions.</p> : null}
        {task.reconciliationHistory.map((entry) => <p className="helper-copy" key={entry.id}>Reconciliation: {entry.explanation}</p>)}
        <p className="helper-copy">Model requests: {task.modelCallCount}/{task.limits.maxModelCalls} · recovery attempts: {task.recoveryAttemptCount}/{task.limits.maxRecoveries}</p>
        <details className="connection-details"><summary>Saved execution limits</summary><p className="helper-copy">{task.actionHistory.length}/{task.limits.maxActions} actions · {task.limits.maxAttemptsPerStep} attempts per logical step · {task.limits.taskTimeoutMs / 1000} seconds from creation. Limits persist across resume.</p></details>
        {task.status === 'recovering' ? <p role="status">Updating the existing plan from fresh browser evidence…</p> : null}
        {task.recoveryHistory.map((entry, index) => <p className="helper-copy" key={`${entry.at}-${index}`}>Plan update: {entry.patch.explanation}</p>)}
        {task.plan ? <ol className="plan-steps">{task.plan.steps.map((step, index) => <li key={step.id}><details><summary><span className={`step-status status-${step.status}`}>{index + 1}. {step.status.replaceAll('_', ' ')}</span><strong>{step.description}</strong></summary>
          <p>{step.expectedResult}</p><dl className="details-list"><div><dt>Action / risk</dt><dd>{step.action.type} / {step.risk}</dd></div><div><dt>Verification</dt><dd>{step.verification.type}</dd></div><div><dt>Dependencies</dt><dd>{step.dependencies.join(', ') || 'None'}</dd></div><div><dt>Stable ID</dt><dd>{step.id}</dd></div></dl><pre className="observed-text">{JSON.stringify({ action: step.action, verification: step.verification, preconditions: step.preconditions }, null, 2)}</pre></details></li>)}</ol> : null}
        <ActivityLog task={task} expanded={preferences.expandEvidence} />
        {task.errors.length ? <details className="connection-details" open={task.status === 'failed' || (task.status === 'paused' && Date.parse(task.errors.at(-1)!.at) >= Date.parse(task.actionHistory.at(-1)?.recordedAt ?? task.createdAt))}><summary>Error history ({task.errors.length})</summary>{task.errors.map((entry, index) => <p className="tool-error" key={`${entry.at}-${index}`}>{new Date(entry.at).toLocaleTimeString()} · {entry.message}</p>)}</details> : null}
      </div> : null}
      {error ? <p className="tool-error" role="alert">{error}</p> : null}
    </>}
  </section>;
}
