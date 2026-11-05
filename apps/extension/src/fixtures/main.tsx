import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function Fixture() {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [delayed, setDelayed] = useState(false);
  const [privacy, setPrivacy] = useState(true);
  const [dangerCount, setDangerCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return <main>
    <header><span className="fixture-brand">ClickFlow <span>Browser lab</span></span><span className="fixture-badge">LOCAL FIXTURE ONLY</span></header>
    <h1>Small actions. Observable results.</h1>
    <p className="intro">A deterministic page for testing observation, safe interaction, and verification. These controls do not make purchases, send messages, or change an account.</p>
    <div className="fixture-grid">
      <section aria-labelledby="safe-heading">
        <h2 id="safe-heading">Safe controls</h2>
        <label htmlFor="fixture-search">Search</label><input id="fixture-search" type="search" placeholder="A native search input" autoComplete="off" />
        <label htmlFor="fixture-controlled">Controlled query</label><input id="fixture-controlled" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="A React controlled input" autoComplete="off" />
        <output id="fixture-controlled-output">Controlled value: {query || '(empty)'}</output>
        <div className="fixture-actions">
          <button id="fixture-reveal" type="button" onClick={() => setCount((value) => value + 1)}>Reveal result</button>
          <button id="fixture-delay" type="button" onClick={() => { setDelayed(false); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setDelayed(true), 1_500); }}>Reveal delayed result</button>
          <button id="fixture-no-change" type="button">No visible effect</button>
          <button id="fixture-disabled" type="button" disabled>Disabled control</button>
        </div>
        <div id="fixture-result" hidden={count === 0} role="status">Result opened · count <span id="fixture-count">{count}</span></div>
        <div id="fixture-delayed-result" hidden={!delayed} role="status">Delayed result is ready.</div>
      </section>
      <section aria-labelledby="edge-heading">
        <h2 id="edge-heading">Targets and boundaries</h2>
        <p>Both buttons have the same accessible name. The agent must reject an ambiguous match.</p>
        <div className="fixture-actions"><button id="fixture-duplicate-a" type="button">Duplicate target</button><button id="fixture-duplicate-b" type="button">Duplicate target</button></div>
        <div hidden><button id="fixture-hidden" type="button">Hidden control</button><p>hidden-unrelated-fixture-content</p></div>
        <hr />
        <p>These inert controls simulate high-impact operations. Fixture tools must block them.</p>
        <div className="fixture-actions"><button id="fixture-purchase" type="button" onClick={() => setDangerCount((value) => value + 1)}>Purchase</button><button id="fixture-send" type="button" onClick={() => setDangerCount((value) => value + 1)}>Send message</button></div>
        <form onSubmit={(event) => { event.preventDefault(); setDangerCount((value) => value + 1); }}><button id="fixture-submit" type="submit">Submit consequential form</button></form>
        <output id="fixture-danger-count">Consequential attempts: {dangerCount}</output>
      </section>
    </div>
    <section className="privacy-section">
      <label className="fixture-toggle"><input type="checkbox" checked={privacy} onChange={(event) => setPrivacy(event.target.checked)} /> Show privacy test samples</label>
      <p>All values below are artificial test strings. Observations must exclude them. Screenshots must be blocked while these samples are displayed.</p>
      {privacy ? <div data-sensitive="true" className="fixture-grid">
        <div><label htmlFor="fixture-password">Password</label><input id="fixture-password" type="password" defaultValue="fixture-password-do-not-collect" /><input type="hidden" name="auth_token" value="fixture-hidden-token-do-not-collect" readOnly /></div>
        <div><label htmlFor="fixture-token">API token</label><input id="fixture-token" defaultValue="sk-fixtureDoNotCollect123456789" readOnly /><p>private-fixture-note-do-not-collect</p><p>Bearer fixture-token-do-not-collect</p></div>
      </div> : null}
    </section>
    <section aria-label="Additional safe controls">
      <h2>Action coverage</h2>
      <label htmlFor="fixture-notes">Notes</label><textarea id="fixture-notes" />
      <label htmlFor="fixture-select">Sort order</label><select id="fixture-select"><option value="price">Price</option><option value="rating">Rating</option></select>
      <p id="fixture-extract">Aster laptop: 16 GB RAM, 512 GB storage.</p>
    </section>
    <footer>This page is a fixture, not an AI-generated plan. Use the installed ClickFlow panel to run the browser tools.</footer>
  </main>;
}

const root = document.getElementById('fixture-root');
if (!root) throw new Error('Fixture root missing');
createRoot(root).render(<StrictMode><Fixture /></StrictMode>);
