import { isSupportedPageUrl, type TaskState, type VerificationResult } from '@clickflow/shared';

export function EvidenceList({ evidence }: { evidence: VerificationResult['evidence'] }) {
  return <ul className="evidence-list">{evidence.map((entry) => <li key={entry.id}>
    <p>{entry.summary}</p>
    {isSupportedPageUrl(entry.sourceUrl) ? <a href={entry.sourceUrl} target="_blank" rel="noreferrer">{entry.sourceUrl}</a> : <span>Source unavailable</span>}
    <p><time dateTime={entry.capturedAt}>{new Date(entry.capturedAt).toLocaleString()}</time> · {entry.kind}</p>
    <p className="helper-copy">Evidence {entry.id} · observation {entry.observationId}</p>
  </li>)}</ul>;
}
function Citation({ quote, evidenceId }: { quote: string; evidenceId: string }) {
  const excerpt = <blockquote><p>{quote}</p><small>Recorded evidence: {evidenceId}</small></blockquote>;
  return quote.length > 360 ? <details><summary>Read recorded excerpt</summary>{excerpt}</details> : excerpt;
}

export function TaskResults({ task }: { task: TaskState }) {
  const result = task.result;
  const terminal = task.status === 'cancelled' || task.status === 'failed';
  if (!result && !terminal && task.status !== 'waiting_for_model') return null;
  const label = task.status === 'cancelled' ? 'Task cancelled' : task.status === 'failed' ? 'Task failed' : task.status === 'waiting_for_model' ? 'Assessing results' : result?.status === 'completed' ? 'Completed with evidence' : result?.status === 'partial' ? 'Partial result' : 'More evidence needed';
  const unresolved = task.plan?.steps.filter((step) => ['failed', 'blocked', 'skipped'].includes(step.status)) ?? [];
  return <section className={`task-result result-${task.status === 'cancelled' ? 'cancelled' : result?.status ?? 'waiting'}`} aria-labelledby="result-heading">
    <p className="eyebrow">TASK RESULT</p><h3 id="result-heading">{label}</h3>
    {task.status === 'waiting_for_model' ? <p>Checking original criteria against recorded sources. Browser actions are paused.</p> : null}
    {terminal ? <p>{task.status === 'cancelled' ? 'No further actions will be scheduled. Previously dispatched website effects may remain.' : 'Execution ended with an error. Inspect the verified work and error history.'}</p> : null}
    {result ? <>
      <p>{result.summary}</p>
      {task.completionHistory.at(-1) ? <p className="helper-copy">Assessment of plan v{task.completionHistory.at(-1)!.planVersion} · <time dateTime={task.completionHistory.at(-1)!.at}>{new Date(task.completionHistory.at(-1)!.at).toLocaleString()}</time></p> : null}
      <ul className="criterion-list">{result.criteria.map((criterion) => <li key={criterion.criterionId}>
        <strong>{task.plan?.goalCriteria.find((entry) => entry.id === criterion.criterionId)?.description ?? criterion.criterionId}</strong>
        <span className={`criterion-status criterion-${criterion.status}`}>{criterion.status === 'met' ? 'Supported' : criterion.status === 'unmet' ? 'Missing' : 'Not established'}</span>
        {criterion.citations.map((citation, index) => <Citation key={`${citation.evidenceId}-${index}`} {...citation} />)}
      </li>)}</ul>
      {result.evidence.length ? <details className="connection-details"><summary>Assessment sources ({result.evidence.length})</summary><EvidenceList evidence={result.evidence} /></details> : null}
    </> : null}
    {unresolved.length ? <details className="connection-details"><summary>Failed, blocked or skipped steps ({unresolved.length})</summary><ul>{unresolved.map((step) => <li key={step.id}>{step.description} · {step.status}</li>)}</ul></details> : null}
  </section>;
}

export function LiveExecution({ task }: { task: TaskState }) {
  const completed = task.plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const total = task.plan?.steps.length ?? 0;
  const skipped = task.plan?.steps.filter((step) => step.status === 'skipped').length ?? 0;
  const active = task.pendingAction?.authorization.action;
  const last = task.actionHistory.at(-1);
  const label = task.status === 'waiting_for_model' ? 'Assessing goal criteria' : task.status === 'planning' ? 'Generating the complete plan' : task.status === 'recovering' ? 'Updating the existing plan' : task.status === 'awaiting_confirmation' ? 'Waiting for your approval' : active ? `Current action: ${active.type.replaceAll('_', ' ')}` : task.status === 'completed' ? 'Goal assessment accepted' : 'No browser action running';
  return <section className="live-execution" aria-label="Live execution">
    <p className="eyebrow">EXECUTION</p><strong>{label}</strong>
    {total ? <><progress aria-label="Verified plan progress" value={completed} max={total} /><p>{completed} verified{skipped ? ` · ${skipped} skipped` : ''} · {total - completed - skipped} remaining</p></> : null}
    {task.currentContext ? <p className="current-page">{task.currentContext.title || 'Untitled page'}<span>{task.currentContext.url}</span></p> : null}
    {last ? <p className="helper-copy">Last browser action: {last.authorization.action.type} · {last.dispatchStatus.replaceAll('_', ' ')} · verification {last.verification?.status ?? 'unavailable'}</p> : null}
  </section>;
}

export function ActivityLog({ task, expanded }: { task: TaskState; expanded: boolean }) {
  if (!task.actionHistory.length) return null;
  return <details className="connection-details" open><summary>Activity and verification ({task.actionHistory.length})</summary>{task.actionHistory.map((entry) => <article className="action-outcome" key={entry.authorization.actionId}>
    <strong>{entry.authorization.action.type} · {entry.verification?.status ?? 'unverified'}</strong>
    <p>{entry.dispatchStatus} · <time dateTime={entry.recordedAt}>{new Date(entry.recordedAt).toLocaleTimeString()}</time></p>
    <p>{entry.verification?.explanation ?? entry.error?.message}</p>
    {entry.error && entry.verification ? <p>{entry.error.message}</p> : null}
    {entry.extraction ? <><pre className="observed-text">{entry.extraction.text}</pre><p className="helper-copy">{entry.extraction.sourceUrl} · <time dateTime={entry.extraction.capturedAt}>{new Date(entry.extraction.capturedAt).toLocaleString()}</time></p></> : null}
    <details open={expanded}><summary>Action and evidence details</summary><p className="helper-copy">Step {entry.authorization.stepId} · attempt {entry.authorization.attempt} · action {entry.authorization.actionId}</p>
      <pre className="observed-text">{JSON.stringify({ action: entry.authorization.action, verification: entry.verification?.condition }, null, 2)}</pre>
      {entry.verification?.evidence.length ? <EvidenceList evidence={entry.verification.evidence} /> : <p className="helper-copy">No passing browser evidence was recorded.</p>}
    </details>
  </article>)}</details>;
}
