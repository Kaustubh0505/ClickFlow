import { useEffect, useRef, useState } from 'react';
import { fixtureSessionSchema, isFixtureUrl, isSupportedPageUrl, originPattern } from '@clickflow/shared';
import { browserTool, hasExtensionRuntime } from '../services/browser-tools.js';

export function WebsiteAccess() {
  const installed = hasExtensionRuntime();
  const [origin, setOrigin] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteAddress, setSiteAddress] = useState('');
  const [bound, setBound] = useState(false);
  const refreshId = useRef(0);
  let suppliedOrigin: string | null = null;
  try { const url = siteAddress.includes('://') ? siteAddress.trim() : `https://${siteAddress.trim()}`; if (siteAddress.trim() && isSupportedPageUrl(url)) suppliedOrigin = new URL(url).origin; } catch { /* Invalid input keeps Allow disabled. */ }
  const candidate = origin ?? suppliedOrigin;
  async function refresh() {
    const requestId = ++refreshId.current;
    try {
      const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      const storedSession = await chrome.storage.session.get('clickflowFixtureSession');
      const parsed = fixtureSessionSchema.safeParse(storedSession.clickflowFixtureSession);
      const session = parsed.success && !parsed.data.stopped && parsed.data.tabId === tab?.id ? parsed.data : null;
      const url = tab?.url ?? session?.observation.url;
      const value = url && isSupportedPageUrl(url) ? new URL(url).origin : null;
      const stored = await chrome.storage.local.get('clickflowOrigins');
      const permitted = !!value && Array.isArray(stored.clickflowOrigins) && stored.clickflowOrigins.includes(value) && await chrome.permissions.contains({ origins: [originPattern(value)] });
      if (requestId !== refreshId.current) return;
      setOrigin(value); setAllowed(permitted || !!url && isFixtureUrl(url)); setBound(!!session && session.observation.url === url);
    } catch { setError('Open the site and click the ClickFlow toolbar icon, then refresh site access.'); }
  }
  useEffect(() => {
    if (!installed) return;
    void refresh();
    const changed = () => { void refresh(); };
    const updated = (_id: number, change: chrome.tabs.OnUpdatedInfo) => { if (change.url || change.status === 'complete') changed(); };
    const storage = (changes: Record<string, chrome.storage.StorageChange>) => { if (changes.clickflowFixtureSession || changes.clickflowOrigins) changed(); };
    chrome.tabs.onActivated.addListener(changed); chrome.tabs.onUpdated.addListener(updated);
    chrome.permissions.onAdded.addListener(changed); chrome.permissions.onRemoved.addListener(changed); chrome.storage.onChanged.addListener(storage);
    return () => { refreshId.current++; chrome.tabs.onActivated.removeListener(changed); chrome.tabs.onUpdated.removeListener(updated); chrome.permissions.onAdded.removeListener(changed); chrome.permissions.onRemoved.removeListener(changed); chrome.storage.onChanged.removeListener(storage); };
  }, [installed]);
  async function bind() {
    const result = await browserTool({ kind: 'bind_fixture' });
    if (!result.ok) throw new Error(result.error.message);
    if (!result.session || result.session.stopped) throw new Error('The current page could not be bound. Keep the target tab active and retry.');
    await refresh();
  }
  function grant() {
    if (!candidate) return;
    const requestedOrigin = candidate;
    setBusy(true); setError(null);
    // Call directly from the click gesture, before awaiting any other work.
    void chrome.permissions.request({ origins: [originPattern(requestedOrigin)] }).then(async (granted) => {
      if (!granted) throw new Error('Website permission was declined. No page access was granted.');
      const result = await browserTool({ kind: 'grant_origin', origin: requestedOrigin });
      if (!result.ok) throw new Error(result.error.message);
      await bind();
    }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not grant website access.')).finally(() => setBusy(false));
  }
  async function revoke() {
    if (!origin) return;
    setBusy(true); setError(null);
    try {
      const result = await browserTool({ kind: 'revoke_origin', origin });
      if (!result.ok) throw new Error(result.error.message);
      // Chrome host patterns do not distinguish ports. App consent above is exact-origin.
      if (new URL(origin).hostname !== '127.0.0.1') await chrome.permissions.remove({ origins: [originPattern(origin)] });
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke access.'); }
    finally { setBusy(false); }
  }
  return <section className="foundation-card" aria-labelledby="access-heading"><h2 id="access-heading">Website access</h2>
    <p className="helper-copy">Allow current site grants access and binds the active page. Chrome site settings alone do not create a ClickFlow binding. Access applies to this origin; redirects require a separate grant.</p>
    {installed ? <><p className="site-origin">{origin ?? 'Open a normal webpage, then click the ClickFlow toolbar icon.'}</p>
      {!origin ? <><label className="field-label" htmlFor="site-address">Site address</label><input id="site-address" className="tool-input" type="url" autoComplete="url" value={siteAddress} disabled={busy} onChange={(event) => setSiteAddress(event.target.value)} placeholder="https://www.youtube.com" /><p className="helper-copy">Chrome is hiding the current tab address. Enter the address of the site open in your active tab. ClickFlow checks that it matches after permission is granted.</p></> : null}
      <p role="status">{allowed ? 'Site access allowed' : 'Site access not granted'}</p>
      <p role="status">{bound ? 'Page bound — ready to generate a plan' : 'Page not bound'}</p>
      <div className="tool-buttons"><button className="secondary-button" disabled={busy || !candidate || allowed} onClick={grant}>Allow current site</button><button className="secondary-button" disabled={busy || !allowed || bound} onClick={() => { setBusy(true); setError(null); void bind().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not bind the page.')).finally(() => setBusy(false)); }}>Bind allowed site</button><button className="secondary-button" disabled={busy || !allowed} onClick={() => void revoke()}>Revoke site access</button><button className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh site</button></div>
      {error ? <p className="tool-error" role="alert">{error}</p> : null}</> : <p className="helper-copy">Available in the installed Chrome extension.</p>}
  </section>;
}
