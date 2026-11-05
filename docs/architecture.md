# ClickFlow architecture — Phase 8

Task discovery uses authenticated `GET /api/tasks`, returning a validated `{ task: TaskState | null }` for the single unfinished backend task. This read-only lookup repairs a missing local selection and precedes initial creation. A racing `TASK_ACTIVE` response restores the actual task instead of leaving the rejected UUID selected. Event polling preserves typed 404/401/network errors and defers missing-selection repair during an in-flight operation. Discovery never schedules browser work or clears execution journals. Generate can freshly bind an already permitted active page after Stop.

## Phase 8 checkpoint protocol

`background/task-coordinator.ts` owns task dispatch independently of the panel. It revalidates backend authorization, persists `prepared` before preflight, persists `dispatching`, obtains an idempotent backend dispatch claim, then invokes the existing single-action adapter. Chrome actions are never retried by the network layer. The content runtime caches a completed result by action ID; after worker termination it can return that result without DOM execution. The worker persists `outcome_ready` before attempting delivery and records acknowledgment only after the backend snapshot contains the matching receipt. Missing/corrupt/quota-limited storage fails closed.

`background/journal.ts` serializes trusted-local storage transitions with a bounded active record, receipt index and cancellation intents. It never downgrades dispatching/uncertain work to prepared. A single worker writes task snapshots/cursors monotonically and refuses to overwrite the selected newer task with an old task's late response. Raw images are absent. Existing Phase 7 prepared journals migrate conservatively: a valid cached result is reused, but unknown dispatch remains unknown. An incomplete legacy journal requires inspection rather than automatic deletion.

`background/outbox.ts` retries only idempotent recorded-result/reconciliation/cancellation delivery, with three attempts per flush and bounded backoff. A worker wakeup, pairing change, successful reconnection or explicit Resume can flush it. It does not keep an offline worker alive indefinitely. Missing-task cancellation intents are retained without blocking unrelated outcomes. Stop sets in-memory/session guards immediately, persists intent, attempts backend cancellation independently of older network backoff and prevents old envelopes from dispatching after reconnect. Already sent website effects cannot be undone.

Protocol-2 authorization introduces `/tasks/:id/claim`. The backend durably records action/lease admission before any browser effect. An unclaimed authorization can therefore be reconciled as not dispatched even when its response never reached the extension. A claimed action without a reliable result remains uncertain; a distributed browser/HTTP/disk boundary cannot promise exactly-once website effects. Legacy authorizations default to protocol 1 and require local proof or recorded outcomes. Successful claim and outcome retries are idempotent, and cancellation wins over late replies.

`/tasks/:id/resume` and `/reconcile` require a fresh observation and original tab/window identity, or explicit relinking to the exact expected URL. Resume never performs the old action. It first drains a saved/cached result; otherwise an unclaimed action returns to the same pending step, or an exact input value/selection/navigation predicate can establish desired state without repeating its effect. Click/key/scroll uncertainty cannot be settled by generic matching text. State reconciliation retains `dispatchStatus: uncertain` alongside fresh evidence and a separate audit entry, preserving the distinction between dispatch knowledge and verified state. Unresolved work blocks further authorization and model recovery. A changed URL or interrupted recovery requires an existing-plan patch before Start.

Backend restart pauses execution, confirmation and model waits once. Initial planning uses a persisted request ID; explicit resume of missing-plan work reserves another model request and requires the original URL. Older planning/recovery success and error responses cannot replace a newer request or cancellation. Resume retains the original task deadline and all budgets. Delayed recorded outcomes validate evidence against their recording time; every future dispatch still requires a new observation. Goal completion remains Phase 9.

The panel restores a validated local checkpoint and matching event ID, then reconnects to a current snapshot. Polling backs off while disconnected. Restoration never dispatches, prior confirmation is not restored as consent, and Start remains gated until explicit Resume. Non-sensitive drafts survive closure. Backend checkpoints remain the source of execution truth; the extension's outbox retains unsent results/Stop intent when the backend is unavailable.

Tests use inert pages and isolated Chromium profiles. Browser-process restart, panel closure, network loss and backend restart are exercised directly. Worker termination targets only the observed test extension through the test runner's CDP connection; no debugger permission or CDP automation is included in the installed extension. References: [Playwright worker routing](https://playwright.dev/docs/service-workers), [Chrome target lifecycle](https://chromedevtools.github.io/devtools-protocol/tot/Target/).

Earlier phase sections below retain implementation history. Phase 8 supersedes earlier statements that unknown work had no resume path; it preserves the conservative block when evidence is insufficient.

## Phase 7 access and confirmation boundary

The complete-plan/authorize/execute/verify/outcome/recovery protocol remains the execution path. `background/access.ts` requires both Chrome host access and exact-origin app consent before binding, observing or executing on normal HTTP(S) pages. Known local fixture pages retain their test access. Optional host permissions are requested directly from the panel click gesture; no all-sites permission is required at install. Secret-bearing URLs and privileged pages are unsupported. Every navigation destination needs prior consent; unexpected redirects stop. Removing permission or app consent increments the cancellation epoch, aborts navigation and stops the content session. Fresh binding after access changes is explicit.

`browser/policy.ts` runs independently of model output. Unknown clicks, possible submission and consequential controls need review; secrets/payment/PII fields, private controls, sensitive forms and detected challenges are blocked. `content_prepare` resolves the actual target but performs no action. Its isolated-world SHA-256 fingerprint binds exact action/predicate, session/document/observation/revision, target markup and local form values. Only the digest and sanitized review description leave content. Hashing checks for state changes during its await; execution rehashes, rechecks observer freshness, consumes approval once and performs one synchronous dispatch. Stop/rebinding clears challenges. A changed action, form property, layout, document or expired review cannot reuse approval.

The task service persists review/approval timestamps, exact challenge scope and a bounded lease at `/tasks/:id/review`. Model medium/high risk sets `requiresConfirmation` in its authorization. A recorded human approval is required before such a dispatched outcome is accepted; independent content policy also catches model-labelled low-risk consequences. Restoring a pending review never schedules it. A failed preflight is recorded as not-dispatched, not verified success. Browser-side checks remain authoritative for actual DOM/permission state; a backend cannot prove tab pixels or DOM from JSON alone.

`execution/pairing.ts` exchanges the private setup credential for a random session tied to a validated extension origin. Private atomic pairing records contain only token hashes. Rotation/revocation survives restart; setup is never accepted by production task routes. `Origin` and the extension header must agree when both exist. The server always injects pairing; the optional direct-token adapter exists only for isolated integration test servers. No webpage bridge or externally-connectable API exists. `chrome.storage.local` is restricted to TRUSTED_CONTEXTS. Loopback binding, payload bounds, sanitized errors and bounded pairing attempts supplement authentication.

Screenshot privacy now rejects visible embeds/canvas/video and populated text fields in addition to existing sensitive controls, redacted text and freshness guards. Heuristics are conservative and do not constitute universal private-data detection. Model prompts treat all page content as untrusted data. No model-generated code is evaluated. Native permission dialogs/toolbars and arbitrary third-party website compatibility require manual testing; deterministic browser tests use an inert normal-path page and isolated extension profile.

The phase sections below retain implementation history. Phase 7 supersedes earlier fixture-only, low-risk-only and direct setup-token restrictions.

Chrome can hide the active URL before extension host access, even when the side panel is visible. `WebsiteAccess` supports an explicitly entered site address as a fallback instead of adding broad tab-metadata permissions. Optional permission is requested in the click handler; the worker then checks the newly readable active origin before recording consent. Allow automatically binds; the panel subscribes to tab/access/session changes and distinguishes granted access from a live binding. An already allowed but stopped site has an explicit Bind allowed site control. A regression removes tab URL metadata only in the test panel and verifies the fallback through real worker injection/binding.

Normal-site clicks, edits, selections and keys all conservatively require review: a benign label cannot prove that website handlers will not save data immediately. Known harmless fixture controls retain their deterministic fast path. Read-only observation/extraction, scrolling and ordinary permitted navigation do not incur another model request or interaction approval. This trades some manual review time for an enforceable boundary on arbitrary websites.

## Phase 6 recovery boundary

`agent/recovery.ts` builds a recovery request using the original task and existing plan, never an unrelated new task. The generalized model JSON client retains provider capability checks, deadlines, structured schema validation and sanitized errors. Provider inference retries obtain another persisted reservation before dispatch.

`execution/plan-patcher.ts` is a pure candidate reducer against the exact base plan version. It preserves original goal criteria and completed/resolved steps; only invalid work may change. New IDs inherit existing unresolved logical budgets. It normalizes fresh references, rejects risk downgrades/fabricated evidence/execution claims, validates dependencies/finish structure, and blocks unchanged replay of unverified side effects. Model flags cannot authorize execution or complete a task.

The task service reserves recovery IDs, model calls and recovery attempts before model work. Model operations run outside the short serialized transition queue so Stop remains available. Applying a response requires the same active plan version and an uncancelled recovery checkpoint. Restart pauses interrupted recovery while keeping counters/request IDs. Pending or uncertain dispatches cannot enter recovery; their reconciliation remains Phase 8.

The panel requests one fresh-context update after supported action failures, then waits for review/Start. Manual Recover plan also handles semantic or changed-page contexts after an explicit fixture binding. Polling uses existing task revisions; there is no added polling effect per progress update. Histories retain patch explanations and actual outcomes, with defaulted counters for older schema-1 snapshots. No new permissions or dependencies were added.

## Phase 5 action and verification layer

The existing authorization/dispatch/outcome protocol now carries all action types and an optional typed extraction record. Atomic task storage retains source URL, observation ID and capture time with extraction text. Older snapshots default missing extraction to null. Verification supports counts, selected values, URLs, scroll displacement and the bounded text-v1 extraction schema in addition to existing DOM predicates.

`browser/dom-actions.ts` handles native setters and deterministic fixture key behavior; `content/runtime.ts` executes one validated DOM action. `browser/verifier.ts` waits on relevant events and mutations with a deadline and abort cleanup. It snapshots scroll position before dispatch and validates extraction context without a model call. Finish explicitly returns unknown assessment instead of completion evidence.

The worker handles navigation via Chrome APIs, tracks only its own fixture navigation trail, waits for the expected URL/load event, injects/rebinds the new document and emits navigation evidence. Stop invalidates the binding epoch and cancels navigation waits. BFCache restoration reconnects observation listeners and invalidates old references. Browser controls accept new session IDs even when their revision starts at zero.

The backend permits document changes only for matching pending navigation authorization; subsequent Start uses the accepted current context. Other unexpected document changes remain blocked. The typed action allowlist, low-risk gate, independent fixture policy and one unresolved dispatch rule are retained. No browser permissions or model calls were added for successful verification.

## Boundaries

`apps/extension` owns browser-facing UI, observation, fixture checks, execution, verification, and a local dispatch journal. Its service worker binds only the exact local fixture, dynamically injects fixed isolated code, and coordinates explicit manual observation and single-action probes. Normal websites remain disabled; no automatic content script is declared.

`apps/backend` owns configuration, persistence, the model client, complete initial planner, and one-action orchestrator. Public health is read-only; task operations require a separate private local token. Explicit backend CLI commands can call the model. Requests from unrelated browser origins are rejected; browser task callers must supply the token and an extension origin; full origin-bound pairing is Phase 7. Health access from an extension origin is not authentication.

`packages/shared` is a browser-safe, Zod-only runtime contract package. Both apps consume its built ESM and declarations. No Node APIs, environment variables, backend configuration, or secret values enter this package. Source imports use `.js` extensions for Node ESM compatibility. Build shared before consumers; rebuild shared and restart development servers after changing contracts.

## Shared contracts

- Actions are strict discriminated unions with bounded parameters. All MVP action shapes are defined; only observe, safe click, and type are implemented in Phase 2. Coordinate, debugger, arbitrary JavaScript, and tab-switch actions are absent.
- Targets allow observation-bound references, roles, labels, selectors, text, and semantic descriptions. Semantic descriptions are permitted for unobserved future pages. Selectors are data for a future fixed DOM resolver, never executable JavaScript.
- Plans contain goal criteria, stable step IDs, logical step IDs, typed verification, risks, dependencies, evidence IDs, and a revision. Initial plans must be entirely pending and version 1. Validate unique IDs, acyclic dependencies, at most one active step, and a final finish step depending transitively on all work.
- Logical step IDs will retain retry budgets through recovery replacements. Patch shapes reject conflicting step changes and invented execution claims. Applying patches against actual state, rejecting stale patches, and preserving completed work are Phase 6 responsibilities, not implemented reducers in Phase 1.
- Observations are bounded, document-scoped snapshots. Their persisted screenshot field contains metadata only. Input values and raw image data are deliberately absent; future execution/transport must gate any necessary values or image bytes separately. Strict schema validation cannot identify all sensitive content in visible text: Phase 2 adds conservative runtime filtering for fixtures; broader real-site protections remain Phase 7 work.
- Verification distinguishes passed, failed, and unknown. Passing requires evidence. Completion criteria reference evidence, and a completed task must assess every plan criterion. Validation checks structure and references, not whether a DOM claim is truthful; browser verification and completion assessment remain later phases.
- Action envelopes carry task/step/action IDs, plan version, observation ID, attempt, and expiring authorization lease. Outcomes distinguish dispatch from verification. These are contracts only; no action authorization or scheduler exists yet.
- Task events carry identity, revision, timestamp, and typed payload. Event streaming/replay is deferred; `GET /api/health` is the only current HTTP response contract.

## Durable storage

`TaskStore` exposes initialize, get, list, and save. `AtomicFileTaskStore` stores a versioned snapshot at `DATA_DIR/tasks.json` and validates every read/write.

Creation requires revision 0 and `expectedRevision = null`; updates require the current expected revision and exactly one increment. Preserve original request, creation time, and monotonic update timestamps. One adapter instance serializes writes and allows one winning compare-and-swap update. This is a single-process store; multiple writers/processes require a database or cross-process locking in a later phase.

Writes use a unique same-directory temporary file, restrictive POSIX permissions, file sync, atomic rename, and directory sync. Reads see a complete old or new snapshot. Invalid/corrupt files fail closed and are never silently replaced. Unsupported schema versions require explicit migration. Temporary files left by an abrupt process kill are ignored; normal writes clean up their temporary file. Local filesystem semantics are assumed, not network shares. File permissions do not encrypt stored data.

A failure after rename can mean the new snapshot exists despite a durability error. Callers must reload/reconcile, not retry side effects. This adapter cannot guarantee exactly-once browser operations. Validate and persist action preparation before future dispatch; reconcile uncertain outcomes on resume.

## Future execution lifecycle

Observe → model generates the full plan → user reviews → authorize one action → extension journals and executes → observe and verify → persist result → update the same plan → publish state → continue. Routine verified updates are deterministic. Recovery/semantic uncertainty invokes a model and produces a versioned patch. `finish` requests evidence-based assessment rather than claiming success.

## Configuration and security

Root `.env` is loaded on the backend only, with process environment taking precedence. Missing keys allow health and fixture tools to run; planner requests fail before network access without a key. The configured model is reported without a key or provider URL. Configuration failures list field names, never their values.

The server binds only to `127.0.0.1`. The extension requests `sidePanel`, `activeTab`, `scripting`, `storage`, and loopback host access, with a restrictive local CSP. It does not request the tabs permission, all-sites access, optional normal-site grants, or debugger permission. Runtime allowlists are narrower than the loopback host permission. Chrome host match patterns cannot be restricted to a port, so CSP limits connection to port 3001. Changing backend port requires updating both the extension endpoint and CSP in this phase.

## Verification layers

Vitest covers contracts, configuration, storage, and actual HTTP health behavior. Separate Node tests inspect production extension assets and launch/stop two real backend processes against the same stored task. Preview visual checks validate layout and health interaction only; installed-extension and live-model operation must be reported separately.


## Phase 2 browser tools

Fixed fixture URLs use HTTP loopback port 5173 or 4173 and path `/fixtures/browser.html`, without queries, fragments, or credentials. Commands from the extension's own `sidepanel.html` are validated; webpage/content-script senders cannot invoke the background tool API. No window-message bridge or externally-connectable interface exists.

Binding checks the active tab and focused window, injects `content.js` into isolated frame 0, and uses Chrome's returned document ID for subsequent messages. Content independently validates location and message shape. It installs once per document and never executes model-provided code. Navigation races fail closed.

The observer tracks mutations and focus/input/change/scroll/resize. Snapshots contain up to 100 elements and 20,000 text characters. Hidden/private/sensitive controls and values are excluded; recognizable token-like text is redacted. Label extraction skips private descendants. References require the latest observation and matching document/layout revision. Semantic targets are not resolved heuristically; selectors are restricted.

The executor validates freshness, supported verification, target ambiguity/visibility/enabled/coverage, and a conservative fixture-control allowlist before one synchronous dispatch. Native setters and events support React-controlled inputs. Relevant DOM events drive bounded verification, with cleanup on Stop. Dispatch without verified outcome remains unverified. Observation and evidence summaries do not record raw field values.

The background serializes short session-storage transactions only. It journals action IDs before dispatch, rejects competing commands without losing the running action, and returns existing outcomes on duplicate delivery. Stop is checked synchronously and persisted before notifying content. Late action results preserve Stop. Tab changes/navigation/close stop sessions. Worker interruption requires rebind rather than replay. This is a manual probe journal, not the backend scheduler or an exactly-once guarantee.

Session storage contains sanitized context/outcomes and bounded attempted IDs; it is not full-browser-restart persistence. Backend task storage is not used for probes because no paired task protocol exists yet. Screenshots remain transient.

Screenshots require explicit opt-in, a conservative privacy pass, bounded bytes, throttling, and active-tab/document/viewport/zoom/scroll/revision checks before and after capture and decoding. Wrong/stale bytes are discarded. Sensitive fixture samples block capture. Chrome denial produces an omission reason; toolbar invocation on the active fixture may be needed for temporary activeTab access. No all-sites workaround is used.

## Phase 2 verification layers

Unit tests cover fixture contracts and mocked screenshot races/permissions. Playwright loads the production unpacked extension into a separate temporary Chromium profile and tests injection, document identity, messaging, actions, verification, cancellation, storage, and panel buttons against inert local pages. This does not imply native toolbar/side-panel activation was tested in the user's profile. Successful image capture is distinguished from handled permission omission.

## Phase 3 model boundary

`agent/planning-input.ts` validates transient context/image transport. `model-client.ts` uses the OpenAI SDK with SDK retries disabled, a single outer deadline, bounded transient retries, cancellable waits, metadata checks and normalized errors. It never substitutes the requested model. `planner.ts` sends the full original task and bounded observation with an optional separate image part; it validates structural JSON, initial-plan state, goal identity, dependency order, logical IDs and observed references. Raw images are neither TaskState fields nor logged. The CLI prints validated plans only; storage/orchestration integration is Phase 4.

`prompts.ts` separates initial planning, semantic updates, recovery and completion instructions. Only initial planning is callable in this phase; patches and completion claims cannot mutate state. Page context is explicitly untrusted. The current endpoint metadata advertises image inputs and structured outputs, but live pixel compatibility remains unverified until the optional credentialed smoke test succeeds.

## Phase 4 orchestration

`execution/task-service.ts` serializes short state transitions while model requests run outside the transition queue. Create reserves a stable task ID before model work, so network retries cannot duplicate it. Stop aborts planning and late results cannot replace cancellation. The store persists full initial plans before review.

Start requires a fresh observation of the original fixture document. Authorize prepares one low-risk supported action and stores its lease/correlation envelope in TaskState before responding. No second action can be authorized with an unresolved envelope. Initial element references are uniquely matched to fresh accessible controls; ambiguous, semantic, unsupported or unprovable requests pause. Content policy remains independent of model risk labels.

The panel sends the envelope to the worker. The worker saves a local dispatch journal before invoking the existing content executor and rejects repeated/unknown dispatches. Backend outcome validation checks prepared identity, predicate and evidence/document correspondence. Verified success updates only that step, preserving IDs and pending work. The action history and plan version update atomically; the task pauses for inspection. Failed/uncertain actions cannot count as completed. Final finish assessment is not implemented.

`execution/routes.ts` enforces a separately generated private local token, extension-origin browser calls, bounded JSON and sanitized errors. `access-token.ts` creates the token outside tracked source. This minimum local boundary protects Phase 4 model-backed routes; account pairing, origin binding and revocation are later work. Task events use authenticated revision polling, avoiding EventSource query-string credentials.

Panel reload restores the last task checkpoint; it never dispatches on restore. Backend restart pauses interrupted planning/execution once, preserving any prepared envelope. Persistent unknown dispatches stay blocked pending later reconciliation; this is safety behavior, not full resume support. The shared pendingAction field defaults to null for older schema-1 snapshots.
