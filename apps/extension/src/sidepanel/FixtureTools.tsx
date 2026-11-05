import { useEffect, useRef, useState } from 'react';
import { FIXTURE_URL, fixtureSessionSchema, isFixtureUrl } from '@clickflow/shared';
import type { Action, BrowserToolCommand, FixtureSession, VerificationCondition } from '@clickflow/shared';
import { browserTool, hasExtensionRuntime } from '../services/browser-tools.js';

const target = (selector: string) => ({ strategy: 'selector' as const, selector });

export function FixtureTools() {
  const installed = hasExtensionRuntime();
  const [session, setSession] = useState<FixtureSession | null>(null);
  const [busy, setBusy] = useState(installed);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('laptops');
  const [capture, setCapture] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const epoch = useRef(0);

  function accept(next: FixtureSession | null) {
    setSession((current) => !current || !next || current.id !== next.id || next.revision >= current.revision ? next : current);
  }

  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    void browserTool({ kind: 'get_fixture_state' }).then((response) => {
      if (cancelled) return;
      accept(response.session);
      if (!response.ok) setError(response.error.message);
    }, () => { if (!cancelled) setError('Reload the extension to reconnect to its browser tools.'); }).finally(() => { if (!cancelled) setBusy(false); });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !changes.clickflowFixtureSession) return;
      const parsed = fixtureSessionSchema.safeParse(changes.clickflowFixtureSession.newValue);
      if (parsed.success) accept(parsed.data);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { cancelled = true; chrome.storage.onChanged.removeListener(changed); };
  }, [installed]);

  async function run(command: BrowserToolCommand) {
    const requestEpoch = ++epoch.current;
    setBusy(true); setError(null); setImage(null);
    try {
      const response = await browserTool(command);
      if (requestEpoch !== epoch.current) return;
      accept(response.session);
      if (!response.ok) setError(response.error.message);
      else {
        setError(response.session?.lastError?.message ?? null);
        setImage(response.screenshotDataUrl ?? null);
      }
    } catch {
      if (requestEpoch === epoch.current) setError('The browser tools could not respond. Reload the extension and bind the fixture again.');
    } finally { if (requestEpoch === epoch.current) setBusy(false); }
  }

  function execute(action: Action, verification: VerificationCondition) {
    if (!session || busy || session.stopped) return;
    void run({ kind: 'execute_fixture', sessionId: session.id, actionId: crypto.randomUUID(), action, verification });
  }

  const disabled = busy || !session || session.stopped || !!session.runningActionId;
  const fixtureDisabled = disabled || !session || !isFixtureUrl(session.observation.url);
  const observation = session?.observation;
  const result = session?.lastResult;

  return <section className="fixture-tools" aria-labelledby="tools-heading">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 id="tools-heading">Browser tools</h2><span className="phase-tag">PAGE CONTEXT</span></div>
    <p className="body-copy small">Inspect a real page and test one safe action at a time. These manual tools are the foundation for the agent.</p>
    {!installed ? <div className="tools-notice"><p>Load the unpacked extension to use these controls. The web preview cannot access your browser tabs.</p><a href={FIXTURE_URL} target="_blank" rel="noreferrer">Open the local fixture <span aria-hidden="true">↗</span></a></div> : <>
      <div className="tool-buttons"><button className="secondary-button" disabled={busy} onClick={() => void run({ kind: 'open_fixture' })}>Open test page</button><button className="secondary-button" disabled={busy} onClick={() => void run({ kind: 'bind_fixture' })}>Bind current page</button></div>
      <p className="helper-copy">Allow a normal site in Website access, then bind it. The local fixture remains available for safe testing. Switching tabs or unexpected navigation stops the session.</p>
      {session ? <>
        <div className="bound-state" role="status" aria-live="polite"><strong>{session.stopped ? 'Stopped' : session.runningActionId ? 'Action running' : 'Page bound'}</strong><span>{observation?.title}</span></div>
        <label className="tool-checkbox"><input type="checkbox" checked={capture} onChange={(event) => setCapture(event.target.checked)} /> Request a screenshot when safe</label>
        <div className="tool-buttons tools-operation-controls"><button className="secondary-button" disabled={disabled} onClick={() => void run({ kind: 'observe_fixture', sessionId: session.id, screenshot: capture })}>Observe page</button><button className="stop-button" disabled={session.stopped} onClick={() => void run({ kind: 'stop_fixture', sessionId: session.id })}>Stop tools</button></div>
        <label className="field-label mt-4" htmlFor="fixture-query">Test query</label><input id="fixture-query" className="tool-input" value={query} maxLength={200} disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
        <div className="tool-buttons">
          <button className="secondary-button" disabled={fixtureDisabled} onClick={() => execute({ type: 'click', target: target('#fixture-search'), timeoutMs: 3_000 }, { type: 'element_focused', target: target('#fixture-search') })}>Focus search</button>
          <button className="secondary-button" disabled={fixtureDisabled || !query.trim()} onClick={() => execute({ type: 'type', target: target('#fixture-controlled'), text: query, timeoutMs: 3_000 }, { type: 'text_present', target: target('#fixture-controlled-output'), text: `Controlled value: ${query}` })}>Type test query</button>
          <button className="secondary-button" disabled={fixtureDisabled} onClick={() => execute({ type: 'click', target: target('#fixture-reveal'), timeoutMs: 3_000 }, { type: 'element_visible', target: target('#fixture-result') })}>Reveal result</button>
          <button className="secondary-button" disabled={fixtureDisabled} onClick={() => execute({ type: 'click', target: target('#fixture-delay'), timeoutMs: 5_000 }, { type: 'element_visible', target: target('#fixture-delayed-result') })}>Wait for result</button>
        </div>
        <p className="helper-copy">The manual probes above apply to the local fixture. Use Your task for a permitted normal page.</p>
        {session.stopped ? <p className="helper-copy">Bind the page again for a new session. Stop cannot undo an action already dispatched.</p> : null}
        {result ? <div className="action-outcome" aria-live="polite"><strong>{result.verification?.status === 'passed' ? 'Verified' : result.verification?.status === 'failed' ? 'Verification failed' : 'Not verified'}</strong><p>{result.actionType} · {result.dispatchStatus.replaceAll('_', ' ')}</p><p>{result.verification?.explanation ?? result.error?.message ?? 'No verified outcome available.'}</p></div> : null}
        {observation ? <details className="connection-details mt-3"><summary>Latest observation · {observation.elements.length} controls</summary><dl className="details-list"><div><dt>Page</dt><dd>{observation.url}</dd></div><div><dt>Document revision</dt><dd>{observation.revision}</dd></div><div><dt>Screenshot</dt><dd>{observation.screenshot.status === 'omitted' ? observation.screenshot.reason : 'Captured locally; not stored or sent to the backend.'}</dd></div></dl><pre className="observed-text">{observation.visibleText || 'No relevant visible text.'}</pre></details> : null}
        {image ? <img className="screenshot-preview" src={image} alt="Fresh screenshot of the bound local fixture" /> : null}
      </> : null}
      {error ? <p role="alert" className="tool-error">{error}</p> : null}
    </>}
  </section>;
}
