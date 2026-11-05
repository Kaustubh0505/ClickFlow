# ClickFlow

A Chrome side-panel agent built around complete plans, sequential actions, and verified outcomes.

**Current scope: Phase 8 — interruption recovery, durable outcomes and safe resume.** Complete initial plans, one verified action per Start, bounded plan recovery, site permissions and exact-action confirmation remain. Closing the panel, losing the backend connection or restarting the browser never automatically replays an action. Resume refreshes the browser context and reconciles the checkpoint first. Finish still requests later completion assessment; the agent does not yet run an entire task automatically.

## Requirements

- Node.js 22.13+ on the 22.x line (recommended), 24.x, or 26+, and npm 10+.
- Chrome 120+ for the unpacked extension.
- No API key is needed for Phase 2.

## Install and run

```sh
npm ci
test -f .env || cp .env.example .env
npm run build
npm run dev
```

Backend health: `http://127.0.0.1:3001/api/health`.
Development panel preview: `http://127.0.0.1:5173/sidepanel.html`.
Local fixture: `http://127.0.0.1:5173/fixtures/browser.html`.

The web preview checks the backend but cannot access Chrome extension APIs. It tells you to load the real extension instead of showing fake execution.

`npm run dev` builds shared contracts once and watches both apps. Rebuild shared contracts after changing them. Rebuild/reload the unpacked extension after source changes; web-preview hot reload does not rebuild injected content automatically.

## Load the extension and try the fixture tools

1. Build with `npm run build` and keep `npm run dev` running.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/dist` inside this repository. Reload the extension card after rebuilding.
4. Click the ClickFlow toolbar icon to open the side panel.
5. Choose **Open test page** to open and bind the fixture on port 5173. Alternatively, open the fixture yourself and choose **Bind current page**.
6. Use **Observe page** to refresh context. Expand **Latest observation** to inspect bounded text and screenshot status.
7. Try **Focus search**, **Type test query**, or **Reveal result**. Outcomes distinguish dispatch from verification.
8. Try **Wait for result**, then **Stop tools** during the delay. Stop aborts verification and prevents further actions. The page's already-dispatched timer may still finish; Stop cannot undo it.
9. Bind again after Stop, navigation, reload, or a tab switch.

The two known fixture pages on ports 5173/4173 remain available for testing without a website grant. Other pages require **Website access → Allow current site**, then **Browser tools → Bind current page**. No content script is injected automatically.

## Use a normal website

1. Start the backend and reload the rebuilt extension in `chrome://extensions`. Keep your existing `.env` unchanged.
2. Open **Your task → Local backend connection**, paste the private setup credential from `.data/extension-token` and choose **Save connection**. This exchanges it for an origin-bound session. Saved pre-Phase-7 setup tokens must be paired again. The model API key stays in `.env`.
3. Open the target website and click the ClickFlow toolbar icon. In **Website access**, choose **Refresh site**. If Chrome hides its URL and Allow is disabled, enter the actual open site's address in **Site address** (for example `https://www.youtube.com`). Choose **Allow current site** and accept Chrome's optional host permission when prompted. The worker checks that the entered origin matches the actual active tab after permission is granted. The extension records exact-origin consent, including the port.
4. Allow now binds the page automatically. Wait for **Page bound — ready to generate a plan**. For an already allowed site after Stop/navigation, choose **Bind allowed site** (or Browser tools → Bind current page). Enter a non-sensitive task and choose **Generate plan**. This explicitly sends the instruction and bounded sanitized context to the configured provider. Images remain optional.
5. Review the complete plan and choose **Start next step**. On normal websites, clicks, edits, selections and keys conservatively require confirmation because event handlers can save/transmit immediately, even if the model labelled them low risk. Check the origin, target, reasons and exact action before approving. **Decline and stop** makes no dispatch. Known harmless fixture interactions keep the fast path.
6. Each outcome is verified before the step is completed. Repeat Start for another step, or use Recover plan after inspecting a changed page. Unexpected navigation stops execution; grant the new origin and rebind before recovery. A pending/uncertain dispatch cannot be blindly recovered.
7. **Revoke site access** stops the bound session and invalidates approval. Chrome permission removal also stops it. **Disconnect backend** revokes the paired token once the task has stopped. A stopped or interrupted review never resumes automatically.

To test without external effects, open `http://127.0.0.1:5173/sites/safety.html`, explicitly allow its origin, bind it and ask to click its inert **Send message** control after confirmation. Its counter changes locally; no message or network submission occurs.

For a production fixture server, run `npm run preview -w @clickflow/extension`, open `http://127.0.0.1:4173/fixtures/browser.html` manually, then bind it. **Open test page** uses the development server on port 5173.

## Resume after an interruption

1. Keep the backend running, or restart it with `npm run dev` / `npm run build && npm start`. Rebuild and reload `apps/extension/dist` after upgrading to Phase 8. Keep your existing `.env` and pairing.
2. Open the panel. Its last task snapshot, event cursor, non-sensitive draft, action checkpoint and saved Stop intents survive panel closure. An offline snapshot is labelled; restoring it schedules no browser action. A running action can finish and record its outcome while the panel is closed.
3. Open the permitted expected page shown in the Resume section and choose **Resume task**. Resume first delivers saved outcomes/cancellation, then freshly binds and observes the active page. It never clicks, types or repeats the old action.
4. If a browser restart changed tab/window identity, check **Use this active tab if the original tab no longer exists**. Relinking requires the exact expected URL and existing site access. Different URLs pause for **Recover plan**; interrupted initial planning requires its original URL before any new inference.
5. Inspect the reconciliation. A saved verified outcome is submitted once. A protocol-2 action that never claimed dispatch returns to pending. An uncertain input assignment, selection or navigation can complete only when fresh evidence matches its exact intended value/URL. An uncertain click/key/relative scroll stays blocked even if a generic page predicate matches. Inspect the website's actual records and Stop that task if a reliable outcome cannot be recovered.
6. Choose **Start next step** only after the fresh checkpoint is ready. Interrupted confirmations require a new action review; prior approval is never silently reused. If initial inference was interrupted before a plan existed, Resume explicitly requests another complete plan within its remaining model/time budget.

**Stop task** blocks local dispatch immediately, aborts waits where possible and saves backend cancellation for delivery. It also attempts backend Stop independently of outcome backoff. Stop cannot undo an effect already sent to a website. Cancelled tasks cannot resume. If the connection returns, versioned event polling delivers a current snapshot and flushes recorded outcomes/Stop intents; it never schedules a browser action.

Limits are retained across resume, including the original task deadline (default ten minutes from creation), action/model counts and logical-step attempts. Resume does not reset them. An expired task remains inspectable; Stop it and create a fresh task when appropriate. A crash after dispatch was claimed but before a reliable outcome was recorded can remain uncertain: this is deliberately conservative, not an exactly-once guarantee for external website effects.

## Observation, actions, and screenshots

- Observation includes actual Chrome tab/window/document identity, URL/title, viewport/zoom/scroll, document revision, bounded text, and up to 100 visible interactive elements. Arbitrary input values are not collected.
- Targets support fresh observation references, native roles/names, labels, visible control text, and restricted single-ID/name/data-testid selectors. Missing, ambiguous, disabled, covered, and stale targets fail closed.
- Implemented actions are listed in Phase 5 below. Phase 6 recovery can resolve semantic targets from fresh observed controls before deterministic execution.
- Typing uses native setters and events and is tested against native and React-controlled inputs. It does not provide universal trusted mouse/keyboard events.
- Event-driven verification supports visible/hidden/focused elements, exact input values, and sanitized visible text. There is no fixed sleep after every action.
- Independent browser policy requires approval for normal-site interactions that can trigger handlers, consequential controls and possible form submission. Medium/high model risk also forces review. Passwords, tokens, payment/PII fields, private-marked controls, sensitive typing, sensitive forms and detected CAPTCHA/access-control challenges remain blocked even with approval.
- Screenshots are off by default, transient, size-bounded, throttled, and guarded by active-tab/document/revision/viewport/zoom/scroll checks before and after capture and decoding. No image bytes enter storage. Manual observations remain local; Generate plan sends a safe requested screenshot transiently to the backend/model.
- Privacy samples are visible by default, so capture is blocked. To try a safe capture, uncheck **Show privacy test samples** on the fixture, then request a screenshot from the panel. If Chrome denies capture, invoke the ClickFlow toolbar while the fixture is active for temporary `activeTab` access and retry. Do not grant all-sites access as a workaround.

Recognizable tokens, email addresses, long card-like numbers, private marked subtrees, sensitive controls and hidden content are filtered or excluded. Recognizable private task text is rejected before model transmission, and backend input validation also rejects unsanitized text/secret-bearing URLs from alternate callers. Screenshots are omitted for visible embedded/canvas/video content or populated text fields. These heuristics cannot identify all private information; use non-sensitive pages and keep secrets out of instructions. Page text and pixels are untrusted model context and cannot authorize tools or override the user's goal.

## Configuration

Copy `.env.example` to `.env` if desired; never commit it. Process environment takes precedence. Health and fixture tools need no key. Planner commands explicitly send their supplied context to the configured provider.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_API_KEY` | empty | Backend-only secret used by planner commands |
| `MODEL_BASE_URL` | `https://openrouter.ai/api/v1` | Trusted provider endpoint |
| `MODEL_NAME` | `nvidia/nemotron-3.5-super-vl:free` | Explicit model selection; no substitution |
| `PORT` | `3001` | Backend loopback port |
| `DATA_DIR` | `.data` | Atomic snapshot directory, relative to repository root |

Do not use `VITE_` prefixes for secrets. Changing the backend port also requires changing the extension health endpoint and CSP. Free-model latency/availability is not guaranteed; the planner checks live capability metadata before each call.

## Tests and checks

Install the version-matched test browser once:

```sh
npx playwright install chromium
```

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:restart
npm run test:extension
npm run test:browser
# All checks, including the real-extension Chromium tests:
npm run check
```

- Unit tests cover schemas, fixture boundaries, screenshot privacy/freshness/rate/permissions, configuration, storage, and HTTP boundaries.
- Restart tests use actual backend processes and isolated temporary storage.
- Asset checks build with a sentinel API key and check local entrypoints, minimal permissions, and no secret leakage.
- Playwright loads the production unpacked extension in a separate temporary Chromium profile and starts a local fixture server on port 4173. It exercises Chrome injection, tab messaging, content execution, verification, session storage, Stop, and panel buttons. Your personal Chrome profile is untouched. Port 4173 must be free.
- Tests never make purchases, send messages, run destructive operations, or call a live model in the ordinary suite. The separate live test requires explicit opt-in.
- The browser suite distinguishes successful screenshot capture from explicit permission omission. A test profile without a user toolbar invocation may lack an `activeTab` capture grant.
- Screenshots are saved under ignored `test-results/`. Loading panel HTML in the isolated profile is separate from native toolbar/side-panel activation.

`CLICKFLOW_TEST_CHROMIUM` can specify a compatible test browser executable. Prefer Playwright's installed version.

## Structure

```text
apps/backend/src/      Health, backend config, atomic task storage
apps/extension/src/
  background/          Binding, session transactions, screenshot guards
  browser/             Privacy, observation, targets, policy, verification
  content/             Fixed isolated runtime and single-action execution
  sidepanel/           Task input/review/Start/Stop and manual fixture tools
  fixtures/            Deterministic native/React and safety controls
packages/shared/src/  Strict schemas and inferred types
tests/browser/        Real unpacked-extension tests
docs/architecture.md  Ownership and security boundaries
DESIGN.md             Tokens, component states, layout, motion
progress.md           Actual results, limits, and next steps
```

## State and limitations

The task store uses validated atomic snapshots, revision checks and one writer. Production task routes require a paired, origin-bound session. Only hashes are persisted in private `.data/pairing.json`; the setup credential is accepted only at pairing. The backend binds `127.0.0.1`, checks browser origins, limits payloads/rate-limits pairing and returns sanitized errors. Extension storage is restricted to trusted extension contexts. Public health remains read-only.

Manual browser bindings use `chrome.storage.session` and require fresh binding after a full browser restart. Task journals, receipts, cancellation intents, the selected task checkpoint/cursor and non-sensitive draft use trusted-only `chrome.storage.local`. The worker owns durable task dispatch/outcome delivery independently of the panel. Short serialized storage transactions do not hold a lock during browser waits or network backoff.

Cross-origin frames, closed shadow roots, coordinates, debugger/native input and SSE (versioned event polling is implemented) are not enabled. Sites requiring trusted native input may fail safely. High-risk navigation steps are conservatively blocked; ordinary navigation requires an already-approved destination and exact URL verification. Unexpected redirects stop rather than automatically granting access. Page mutation can invalidate a review and require a new observation/plan. Reconciliation handles recorded outcomes, proven no-dispatch and exact idempotent state; uncertain side effects remain blocked. Final evidence-based goal assessment is Phase 9. No publication or deployment is included.

## Troubleshooting

- **Stop the current task / missing checkpoint:** the panel discovers the backend's actual unfinished task before creating another and restores it if a previously selected request was rejected or lost. Review **Original task**, then choose Resume or Stop. This lookup does not execute or cancel anything. Stop must be acknowledged before a new task can begin. Generate refreshes a stopped/missing binding only on an already permitted active page; it does not grant site access.
- **Offline versus missing task:** a missing task is not a backend outage. A rejected, uncreated selection is repaired against the authenticated active-task endpoint; action journals and cancellation intents are retained. An actual connection failure displays local backend startup instructions. After updating, restart the backend and reload the unpacked extension so both sides use the current protocol.
- **Tools absent in the preview:** load the unpacked extension; normal pages have no extension runtime.
- **Site permission required:** keep the target tab active, invoke the toolbar, Refresh site, explicitly allow it and bind again. Secret-bearing URLs and privileged browser pages are unsupported.
- **Allow disabled/current site unknown:** Chrome may hide tab metadata before host permission. Enter the exact current website in Site address; Allow requests only that host and validates the active origin afterward. Chrome's ordinary website settings are separate from extension access. No broad `tabs` permission is needed.
- **No active page binding:** site access and live binding are separate states. Allow binds automatically in this build; use Bind allowed site after Stop/tab switches and verify the Page bound status before Generate. An older loaded extension must be reloaded in `chrome://extensions`.
- **Pairing/401 error after upgrade:** paste `.data/extension-token` into Local backend connection and Save connection again. Disconnect revokes the current paired session. Do not paste MODEL_API_KEY here.
- **Approval stale:** the page, form, target or action changed, or the two-minute review expired. Inspect/Stop before making a fresh task; a changed action never inherits approval.
- **Outcome saved locally / worker interrupted:** reopen the panel and use Resume before Start. A recorded result is delivered without browser replay. Do not clear the journal to retry an uncertain click.
- **Resume says uncertain:** current DOM alone cannot prove that an earlier click/message/purchase occurred. Inspect the website's actual records; Stop this task if the old outcome cannot be recovered. A new task must plan from fresh state and still requires normal confirmations.
- **Task limit reached:** resume retains the original deadline/attempt counters. Expired tasks remain inspectable; do not reset stored counters to force a retry.
- **Corrupt/full storage:** no dispatch is permitted without a durable checkpoint. Preserve the journal and backend snapshots, fix storage/restore a backup, then inspect/reconnect. The app never silently deletes an uncertain checkpoint.
- **Stopped after a tab switch/reload:** return to the fixture and bind again.
- **Stale observation:** observe before acting. References expire after relevant document, focus, input, scroll, resize, or layout changes.
- **Screenshot omitted:** inspect its reason; hide privacy samples or invoke the toolbar on the fixture for temporary capture permission. Do not broaden permissions.
- **Backend offline:** start `npm run dev` or `npm run build && npm start`, then retry health checking. Local fixture tools do not depend on the model/backend; planning and Start require both.
- **Missing browser:** run `npx playwright install chromium`.
- **Port in use:** free test port 4173; development uses 5173, and the backend uses 3001.
- **Missing shared package:** build `@clickflow/shared`; root scripts already do this.
- **Invalid stored state:** preserve the snapshot and restore a known-good backup. There is no destructive automatic reset.

## Phase 3 planning

Copy `.env.example` to root `.env` and set `MODEL_API_KEY` to your OpenRouter key. Never put it in extension code, Vite variables, input JSON, screenshots or Git. Defaults are `MODEL_BASE_URL=https://openrouter.ai/api/v1` and `MODEL_NAME=nvidia/nemotron-3.5-super-vl:free`. Set `MODEL_TIMEOUT_MS=60000` and `MODEL_MAX_RETRIES=2` as desired (maximum 180000 ms / two retries). The overall deadline includes discovery, requests and backoff. Remote provider URLs require HTTPS; loopback HTTP is available for tests.

Run the explicitly optional synthetic vision smoke test from the repository root:

```sh
RUN_LIVE_MODEL=1 npm run test:model:live
```

Without opt-in or a key it prints SKIPPED and sends nothing. With both, it sends a synthetic one-pixel image and non-sensitive page context, checks advertised image/JSON capabilities, requests a complete plan and validates it. It executes no browser actions. A PASS confirms that request's image acceptance and valid planning response, not general browser automation or visual accuracy. Free endpoints have variable capacity/latency and may impose data-use terms; use only non-sensitive test data.

For a supplied browser context:

```sh
npm run plan -- /absolute/path/to/planning-input.json
```

The input is a strict object with `originalRequest` (string), `observation` (the existing shared Observation contract), optional `constraints` (string array), and optional `screenshot: { id, dataUrl }`. The observation must be freshly captured within 60 seconds. Omitted screenshots require omitted metadata. Captured images require matching ID/MIME/time metadata and a bounded PNG/JPEG base64 data URL (maximum two million characters); remote image URLs are rejected. Images are sent as transient `image_url` content, separate from the JSON context. The backend cannot independently prove pixels match a real tab: use the extension freshness/privacy layer when Phase 4 connects transport. Do not manually submit private page data. CLI output is the validated plan, not a persisted/started task.

The client verifies `/models/{configured-model}/endpoints`, then uses `/chat/completions` with Bearer authentication, JSON-schema response format and `provider.require_parameters=true`. Custom base URLs must implement these OpenRouter-compatible capability and completion endpoints. Unsupported models/endpoints fail with an actionable error; there is no model substitution or JSON-mode downgrade. A plain OpenAI-compatible completion endpoint without the discovery API is insufficient in this phase.

Initial plans must retain the exact original goal, use ordered acyclic dependencies and unique stable/logical IDs, contain no execution claims, and end in a finish assessment depending on all work. Unobserved future targets use semantic descriptions. Initial selectors and invented observation references are rejected. Runtime Zod validation remains authoritative because JSON Schema cannot express all plan invariants. Recovery is now enabled as described below; final completion assessment remains later work.

Provider errors are normalized without raw response bodies. Authentication/credit errors and invalid output are not retried. Transient network/408/429/5xx failures have bounded backoff; long cooldowns are returned to the caller. Cancellation interrupts requests/backoff and rejects late results. CLI Ctrl+C cancels planning. Phase 4 adds authenticated task routes described below; CLI calls remain separate.

Official references checked 2026-10-28: [model endpoint metadata](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding). Advertised support can change; a live image request is the final compatibility check.

## Phase 4 — generate, review, Start, verify

1. Start `npm run dev` from the repository root. Keep your existing `.env` with `MODEL_API_KEY`; do not overwrite it.
2. Build/reload the unpacked extension from `apps/extension/dist` and open its side panel.
3. Under **Your task → Local backend connection**, paste the contents of `.data/extension-token` and click **Save connection**. Read that file locally in your editor or terminal. It is a separate generated connection credential, not your model API key. With a custom DATA_DIR, use `extension-token` in that directory. The server prints only its path. Keep it private.
4. In **Browser tools**, choose **Open test page** (or bind the exact fixture already open). Keep that fixture active.
5. Enter `Click the Search field so it is focused. Do not type, navigate, or scroll.` and choose **Generate plan**. This explicitly sends sanitized fixture context and the original instruction to the configured model. Screenshots are optional and still follow the privacy/capture checks.
6. Wait for **ready**, then inspect all plan steps. Expand a step to inspect exact action parameters, verification, prerequisites, risk and stable ID.
7. Choose **Start next step**. The backend saves a complete action authorization before the extension journals and dispatches it. A fresh observation and matching document are required. The result is verified, recorded and applied to the original plan; the task pauses. Routine verified outcomes make no model call.
8. Inspect the activity evidence and remaining steps. Another Start can execute the next supported pending step; it never blindly repeats a failed/unknown action. **Stop task** cancels planning and stops local scheduling/verification. It cannot undo a dispatched effect. Stop the current task before generating a new one.

The Phase 4 baseline executed only `observe`, safe `click`, and `type`; Phase 5 coverage is described below. High/medium risk steps, unresolved semantic targets and unprovable prerequisites pause with an explanation. Existing observed references are matched uniquely against fresh accessible role/name data before authorization. The content runtime independently checks visibility, ambiguity and its fixture-control allowlist.

## Phase 5 — action coverage

Rebuild with `npm run build`, reload the unpacked extension, and keep `npm run dev` running. Existing backend credentials and the local connection token are reused. General-site access remains disabled. Only `/fixtures/browser.html` and `/fixtures/details.html` on `http://127.0.0.1:5173` or `:4173` are permitted, without query strings or fragments. Navigation stays on the current fixture origin.

| Action | Execution | Verification |
| --- | --- | --- |
| observe | Fresh bounded DOM snapshot | Visible text, controls, counts or URL |
| click | Unique, enabled, uncovered allowlisted control | Focus, visibility, text or another typed condition |
| type / clear_input | Native setters plus input/change events for inputs and textareas | Exact value; React render state also supported |
| select_option | Available native select option, including disabled-option checks | selected_option_equals |
| scroll | Bounded instant viewport scroll | scroll_position_changed against the pre-action position |
| press_key | Synthetic DOM keyboard events with deterministic fixture button activation, text editing, caret and bounded Tab handling | A typed observable predicate |
| wait | Observe the requested condition until a bounded deadline | Relevant DOM/input/focus/scroll events; no fixed sleep after an action |
| navigate | Chrome tabs API to a known fixture URL | Exact URL plus fresh document binding |
| go_back / go_forward | Chrome history within the worker's recorded fixture navigation trail | Exact expected fixture URL and fresh document |
| extract_text | Bounded, sanitized visible text from an allowlisted target | extracted_data_matches_schema with schemaId text-v1 |
| finish | Record completion-assessment request | unknown assessment; task pauses and the step becomes blocked |

Keys are DOM events and deterministic fixture behaviors, not trusted OS keystrokes. Arbitrary websites may ignore synthetic events or need native defaults; those capabilities are not claimed. Enter/Space can activate only known safe buttons. Key actions inside forms and sensitive/consequential controls are blocked. Unsupported/unobservable effects fail verification rather than claiming success.

The original fixture now includes **Action coverage** controls below the privacy samples: Notes, Sort order, and a small product text record. Scroll to controls before acting. The compact details fixture contains Search, Sort order and the same product record. Text extraction returns `outputKey`, `schemaId`, `text`, `sourceUrl`, `capturedAt` and `observationId`; accepted records persist in action history and appear in the panel. `text-v1` requires non-empty bounded text; unknown extraction schema IDs are rejected.

Example tasks: `Clear the Controlled query field`, `Set Sort order to Rating`, or `Extract the visible Aster laptop description`. Plan generation depends on actual visible context. Controls on unseen pages remain semantic targets and may need Phase 6 resolution; no selector is fabricated. Routine successful steps require no additional model call or screenshot.

Navigation discards the old binding and references. Back/Forward are enabled only for history created by agent navigation during the current binding; they never explore unrelated user history. Manual rebinding resets the recorded trail. Unexpected navigation or tab changes stop execution. Stop during navigation can leave an already-requested page load in progress, but cannot create an active replacement binding or schedule another action.

The full-plan review and one-step-per-Start policy remain. Recovery is described below; broad permissions and final evidence-based task completion are later phases. `finish` intentionally produces no passing completion evidence. A model claim or browser API success is insufficient to complete a task.

## Phase 6 — recovery without restarting the plan

Reload the unpacked extension after building. Existing model credentials and the private backend connection token are reused. Failed target resolution or verification automatically requests one recovery update after the action outcome has been persisted. Authorization failures caused by semantic targets, stale observations or changed documents also request recovery when fresh bound fixture context is available. Other browser errors can be inspected and addressed with **Recover plan**. A stopped/unbound fixture must be explicitly bound again first.

Recovery captures fresh bounded DOM context and, if requested and safe, a screenshot. The backend sends the original goal, existing plan, completed work, current/previous action, execution and verification results, recent evidence/errors, current URL/title and remaining constraints. It requests a strict patch schema through the same configured model; no fallback model is selected.

The panel shows **recovering**, request/recovery counters and the patch explanation. Completed steps and unchanged pending steps keep their IDs. A valid patch increments the plan version. Review the update and choose **Start next step**; recovery never dispatches an action itself. Successful ordinary outcomes still update deterministically without a model request.

The authenticated endpoint is `POST /api/tasks/:id/recover` with `{ expectedRevision, requestId, context: { observation, screenshot? } }`. The server supplies the original goal; the caller cannot replace it. Requests reserve their ID and budgets before asynchronous model work. Reusing a request ID returns the checkpoint and does not make another model call. Poll the existing events endpoint for the result.

The reducer rejects stale base versions, completed/skipped-step rewrites, invented evidence, execution claims, fabricated selectors/references, invalid dependencies, risk downgrades and attempts to reset logical IDs. New inserted steps receive new stable IDs but must inherit the logical ID and risk of unresolved work. Valid pending work is preserved; finish dependencies can change to include legitimately inserted work. Fresh observation references are normalized to accessible role/name targets before the next observation invalidates those references.

Default budgets are two authorized attempts per logical step, five recovery requests, fifteen reserved inference requests, fifty action outcomes and ten minutes per task. Recovery failures consume their reservation; backend restart does not reset counters. Additional provider inference retries reserve another model call before sending it. Capability-discovery GETs are not inference calls; the initial reservation is conservatively retained if discovery fails. Action timeouts are capped by the remaining task duration and configured action timeout. Exhausted budgets pause/refuse further work with an explanation.

Unresolved prepared actions and uncertain dispatches require reconciliation before recovery and remain blocked. A dispatched, unverified click/key/navigation cannot be replayed unchanged, even by moving it to another step ID; use fresh evidence and a changed safe action or stop. Idempotent observation/input operations can retry within their original budgets. **Stop task** aborts recovery and late responses cannot apply a patch. There is no recursive automatic model loop; each failure can request one bounded update and the next action requires Start.

Optional synthetic live recovery smoke test (does not operate a browser or persist a task):

```sh
MODEL_TIMEOUT_MS=120000 RUN_LIVE_MODEL=1 npm run test:recovery:live
```

Without opt-in or credentials it skips. Ordinary tests mock model responses and exercise actual extension actions. The live smoke test validates the real provider's patch against the same reducer. Site permissions/confirmations are implemented in Phase 7, and conservative interruption reconciliation in Phase 8. Final completion assessment remains Phase 9.

Verification: ordinary tests mock model planning and use the actual unpacked extension, backend and fixture DOM. The task workflow test navigates, extracts, persists/displays the record and requests finish using one initial planner call with stable plan IDs. Live model calls remain opt-in; this phase does not change model transport. Chrome navigation API reference: [Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs).

`finish` remains an assessment request rather than overall goal completion. The Phase 8 worker now owns a durable journal/outbox and conservative reconciliation as described above. Unresolved side effects remain blocked; inspection never repeats them. Browser bindings remain separate from the persistent action journal and last task checkpoint. Restore alone never dispatches.

Authenticated protocol (all task IDs and bodies validated):

| Operation | Endpoint | Behavior |
| --- | --- | --- |
| Create | `POST /api/tasks` | Client-supplied stable task ID; reserve/persist then plan asynchronously; retries do not duplicate a model request |
| Inspect | `GET /api/tasks/:id` | Current persisted checkpoint |
| Events | `GET /api/tasks/:id/events?afterEventId=TASK_REVISION` | Current typed snapshot or 204; the persisted cursor is checked against its task; polling backs off on disconnect |
| Start | `POST /api/tasks/:id/start` | Exact task revision and fresh bound observation |
| Authorize | `POST /api/tasks/:id/authorize` | Journal task/plan/action/step/observation/attempt/lease identity before dispatch |
| Claim | `POST /api/tasks/:id/claim` | Idempotently persist dispatch admission; protocol-2 effects require a matching claim |
| Outcome | `POST /api/tasks/:id/outcome` | Check matching authorization and verification/evidence; accept each action ID once |
| Stop | `POST /api/tasks/:id/stop` | Cancel model work and prevent new authorization |
| Resume | `POST /api/tasks/:id/resume` | Fresh permitted observation and optional explicit exact-URL tab relink; no browser action |
| Reconcile | `POST /api/tasks/:id/reconcile` | Audit an unresolved action; preserve stable IDs, goal, completed work and budgets |

Production uses `Authorization: Bearer <paired session>` with the matching Chrome extension origin (`Origin`, or `X-ClickFlow-Extension` when Chrome omits Origin). If both headers are present they must agree. Web preview callers cannot access task APIs. `POST /api/pair` exchanges the private setup token, `POST /api/pair/revoke` revokes the current session, and `POST /api/tasks/:id/review` records then approves an exact browser-generated challenge against the current revision. Isolated test servers may inject the direct-token adapter; the shipped server always enables pairing. Optional host permissions are requested per site; no debugger permission was added.

Ordinary browser tests mock planning only and exercise the real backend/extension/DOM. To explicitly run the non-sensitive live agent fixture check after building:

```sh
MODEL_TIMEOUT_MS=120000 RUN_LIVE_AGENT=1 npx playwright test tests/browser/task-runner.spec.ts -g 'optional live model'
```

This override applies only to that process and does not edit `.env`. Free-provider requests can be slow: the Phase 4 validation had one 60-second timeout with no dispatch, followed by a successful live run with a 120-second deadline. No latency guarantee is made. If needed, configure `MODEL_TIMEOUT_MS=120000` in the backend environment and restart it. The live test remains disabled in normal checks.
