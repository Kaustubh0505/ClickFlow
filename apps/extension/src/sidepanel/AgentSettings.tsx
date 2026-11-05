import { DEFAULT_LIMITS, type HealthResponse, type Preferences } from '@clickflow/shared';
import { BACKEND_URL } from '../services/backend.js';

export function AgentSettings({ open, onToggle, preferences, onChange, health, status, error }: {
  open: boolean; onToggle: (open: boolean) => void; preferences: Preferences; onChange: (next: Preferences) => void;
  health?: HealthResponse; status: string; error: string | null;
}) {
  const limit = (key: 'maxActions' | 'maxModelCalls' | 'maxRecoveries' | 'maxAttemptsPerStep', label: string, min = 1) => <label className="settings-field" key={key}>{label}<input className="tool-input" type="number" min={min} max={DEFAULT_LIMITS[key]} value={preferences.limits[key]} onChange={(event) => onChange({ ...preferences, limits: { ...preferences.limits, [key]: Number(event.target.value) } })} /></label>;
  return <details id="agent-settings" className="settings-panel" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary id="settings-summary">Settings</summary>
    <dl className="details-list"><div><dt>Backend</dt><dd>{BACKEND_URL} · {status}</dd></div><div><dt>Model</dt><dd>{health?.model.name ?? 'Connect to read the configured model'}</dd></div><div><dt>Provider endpoint</dt><dd>{health?.model.endpoint ?? 'Configured in backend MODEL_BASE_URL'}</dd></div></dl>
    <p className="helper-copy">Change MODEL_NAME and MODEL_BASE_URL in the backend .env and restart it. API keys stay on the backend.</p>
    <fieldset><legend>Limits for new tasks</legend><p className="helper-copy">You can lower the safety defaults. Existing tasks keep their saved limits.</p><div className="settings-grid">
      {limit('maxActions', 'Maximum actions')}{limit('maxModelCalls', 'Maximum model calls')}{limit('maxRecoveries', 'Recovery attempts', 0)}{limit('maxAttemptsPerStep', 'Attempts per step')}
      <label className="settings-field">Task duration (seconds)<input className="tool-input" type="number" min="1" max={DEFAULT_LIMITS.taskTimeoutMs / 1000} value={preferences.limits.taskTimeoutMs / 1000} onChange={(event) => onChange({ ...preferences, limits: { ...preferences.limits, taskTimeoutMs: Number(event.target.value) * 1000 } })} /></label>
    </div></fieldset>
    <label className="tool-checkbox"><input type="checkbox" checked={preferences.screenshots} onChange={(event) => onChange({ ...preferences, screenshots: event.target.checked })} /> Include screenshots when safe</label>
    <label className="tool-checkbox"><input type="checkbox" checked={preferences.expandEvidence} onChange={(event) => onChange({ ...preferences, expandEvidence: event.target.checked })} /> Expand activity evidence by default</label>
    <p className="helper-copy">Screenshots remain opt-in, transient and privacy-checked. The required execution audit is always retained; this setting changes its display.</p>
    {error ? <p role="alert" className="tool-error">{error}</p> : null}
  </details>;
}
