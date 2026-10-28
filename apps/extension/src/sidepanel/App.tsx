import { useEffect, useState } from 'react';
import type { HealthResponse } from '@clickflow/shared';
import { BACKEND_URL, checkBackend } from '../services/backend.js';

type Connection = { status: 'checking' } | { status: 'connected'; health: HealthResponse } | { status: 'offline' };

export function App() {
  const [connection, setConnection] = useState<Connection>({ status: 'checking' });
  const [checkNumber, setCheckNumber] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void checkBackend(controller.signal).then(
      (health) => { if (!controller.signal.aborted) setConnection({ status: 'connected', health }); },
      () => { if (!controller.signal.aborted) setConnection({ status: 'offline' }); },
    );
    return () => controller.abort();
  }, [checkNumber]);

  function reconnect() {
    setConnection({ status: 'checking' });
    setCheckNumber((previous) => previous + 1);
  }

  const label = connection.status === 'connected' ? 'Backend connected' : connection.status === 'checking' ? 'Checking backend' : 'Backend offline';

  return (
    <div className="panel-shell flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <a className="brand inline-flex items-center gap-2.5" href="#main" aria-label="ClickFlow home">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6 5h7v6H6zM13 11h5v8h-7v-8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="m6 16 3 3-3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          <span>ClickFlow</span>
        </a>
        <span className="phase-tag">PHASE 01</span>
      </header>

      <main id="main" className="flex flex-1 flex-col gap-6 px-5 py-6">
        <div className="connection-row flex flex-wrap items-center justify-between gap-3">
          <p className="connection-label inline-flex items-center gap-2" role="status" aria-live="polite">
            <span className={`status-dot ${connection.status}`} aria-hidden="true" />{label}
          </p>
          <button className="text-button" onClick={reconnect} disabled={connection.status === 'checking'}>Check connection <span aria-hidden="true">↗</span></button>
        </div>

        <section aria-labelledby="welcome-heading">
          <p className="eyebrow mb-2">YOUR BROWSER, WITH A PLAN</p>
          <h1 id="welcome-heading" className="mb-3">A little less clicking.<br /><span>A lot more clarity.</span></h1>
          <p className="body-copy">A browser agent that plans the whole task, takes one action at a time, and checks what happened.</p>
        </section>

        <section className="composer" aria-labelledby="task-heading">
          <label id="task-heading" htmlFor="task" className="field-label">What would you like to do?</label>
          <textarea id="task" rows={4} disabled aria-describedby="task-help" placeholder="Find three laptops under ₹50,000 and compare their specifications…" />
          <div className="composer-bottom flex flex-wrap items-center justify-between gap-3">
            <span className="privacy-label"><span aria-hidden="true">◇</span> Review before running</span>
            <button className="primary-button" disabled aria-describedby="task-help">Generate plan <span aria-hidden="true">→</span></button>
          </div>
          <p id="task-help" className="helper-copy">Task planning and browser actions arrive in later phases. No page data is collected in this build.</p>
        </section>

        <section className="foundation-card" aria-labelledby="foundation-heading">
          <div className="mb-3 flex items-center justify-between gap-3"><h2 id="foundation-heading">The foundation</h2><span className="small-label">BUILD 0.1.0</span></div>
          <p className="body-copy small">The workspace, shared contracts, and durable storage are ready for the execution engine.</p>
          <ol className="flow-list" aria-label="Planned execution lifecycle">
            <li><span className="flow-number">01</span><span><strong>Plan the whole task</strong><small>See every step before you start.</small></span></li>
            <li><span className="flow-number">02</span><span><strong>Act, then verify</strong><small>One action. A checked outcome.</small></span></li>
            <li><span className="flow-number">03</span><span><strong>Keep the plan current</strong><small>Adapt when the page changes.</small></span></li>
          </ol>
          <p className="helper-copy">Lifecycle preview · execution is not available yet</p>
        </section>

        <details className="connection-details">
          <summary>Connection details</summary>
          <dl className="details-list">
            <div><dt>Backend</dt><dd>{BACKEND_URL}</dd></div>
            <div><dt>API</dt><dd>{connection.status === 'connected' ? `v${connection.health.version} · phase ${connection.health.phase}` : 'Not verified'}</dd></div>
            <div><dt>Model integration</dt><dd>Not implemented</dd></div>
            {connection.status === 'connected' ? <div><dt>Configured model</dt><dd>{connection.health.model.name}</dd></div> : null}
          </dl>
          {connection.status === 'offline' ? <p className="helper-copy">Start the local backend with <code>npm run dev</code>, then check the connection again.</p> : null}
        </details>
      </main>

      <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4"><span>Built for deliberate action.</span><span className="footer-badge">LOCAL FIRST</span></footer>
    </div>
  );
}
