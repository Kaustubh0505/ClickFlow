# ClickFlow progress

## Recorded task-creation failure — fixed (2026-10-29)

- Inspected the user's 24-second recording. Site access/binding succeeded, but Generate reported TASK_ACTIVE while the panel displayed an offline checkpoint and Stop could not clear the blocker. Read-only local health and sanitized task metadata confirmed a healthy backend with an older paused task; its history was not deleted or altered.
- Found that Generate replaced the selected ID before a rejected create, leaving a nonexistent ID selected. Event polling collapsed 404 into a generic offline error. Added authenticated, validated GET /api/tasks for the one unfinished task; bootstrap, reconnect and pre-create lookup now restore its actual checkpoint. A create conflict between lookup/POST also restores that task. Discovery neither dispatches nor cancels it, and does not clear action journals/cancellation intents.
- Preserved typed NOT_FOUND, UNAUTHORIZED and network errors. Genuine connection failures show startup instructions; invalid pairing opens connection settings. Initial lookup gates Generate, in-flight creation IDs are protected from poll repair, and restored task details show Original task. Generate can freshly bind an already permitted active page after Stop without granting additional access. Existing worker/executor/approval/verification/store contracts are reused.
- Added two backend discovery/auth tests, five transport/error tests and four real-extension regressions for lost selections, racing creates, uncreated IDs and offline reconnect. The restored-task → Stop → new plan flow passed. Tests exposed and fixed an in-flight lookup race and stopped-binding issue before the final successful run.
- Final checks passed: 267 unit/API tests (19 files), all 67 ordinary browser cases (one optional live-provider case skipped), two process-restart tests, two asset/secret checks, type checking, zero-warning lint and production builds. Total distinct current passing cases/checks: 338. The actual restored-task screenshot at 390px was visually inspected; existing keyboard/reduced-motion/responsive checks passed. Source whitespace checks passed.
- Updated README and architecture. Private .env, pairing, task history and site permissions were preserved. Native Chrome was inspected read-only; the user's installed extension was not reloaded or used to run a search. Restart the backend/reload the extension to activate this build, then review/Stop the restored older task before Generate. Live YouTube/model behavior was not retested. One action per Start and Phase 9 completion limits remain.

## Phase 8 — complete (2026-10-29)

- Added a trusted-local durable execution journal, bounded receipts, cancellation outbox and validated task snapshot/event cursor. The worker owns dispatch and outcome delivery independently of panel lifetime. Storage failure prevents dispatch; reconnect retries recorded network delivery only. Panel restoration never executes browser actions.
- Added protocol-2 backend dispatch claims before browser effects, revision-checked resume/reconciliation endpoints and persisted reconciliation history. Restart pauses interrupted tasks once. Fresh permitted browser observation is required before resuming; changed tab/window identity needs explicit exact-URL relinking. Stable step IDs, original task deadline, attempts and model/action budgets survive restart/resume.
- Resume delivers recorded outcomes first, retrieves surviving content-script result caches before rebinding and distinguishes proven no-dispatch from unknown effects. Exact idempotent input/selection/navigation state can verify its corresponding predicate; generic click/key/relative-scroll conditions cannot prove an earlier effect. Unresolved effects remain blocked. Incomplete legacy journals are not silently discarded or replayed.
- Stop immediately invalidates local dispatch and interrupts waits, persists cancellation and attempts backend cancellation independently of older outcome backoff. Late initial/recovery model replies are rejected by persisted request identity. Interrupted initial planning can request a new full plan with fresh original-page context, within existing budgets. Pending confirmations always require fresh review.
- Reused the existing complete planner, atomic store, browser executor, verifier, site/privacy policy, exact-action approvals, pairing and plan recovery. Added shared resume/journal contracts; background journal/outbox/transport/coordinator modules; read-only content reconciliation; panel Resume/checkpoint/relink states; backend claim/resume/reconcile transitions and stable event cursors. Updated README, architecture and design notes. No new permissions or dependencies; .env and pairing data preserved.

### Checks actually run

- Type checks, zero-warning lint, 260 unit/API tests across 18 files, production builds, two actual-process restart tests and two extension asset/secret checks passed. The complete ordinary browser suite passed: 63 real-extension cases; the optional live-provider test skipped. Current total is 327 distinct passing cases/checks (260 + 63 + 2 + 2); reruns are not counted again. No live model request was made in this phase.
- Nine new browser cases cover panel closure during execution, disconnected outcome delivery, backend restart before dispatch, fresh confirmation after interruption, real worker termination/content-cache recovery, unknown-click refusal, ambiguous/exact input-state reconciliation without new input events, offline Stop, and full Chrome-process restart with explicit tab relinking. All use isolated profiles and inert local pages.
- After the full suite, strengthened the worker-termination regression to prove there was no backend or durable local result before Resume. Its targeted rerun passed: worker global was replaced, cached outcome recovered, click count remained one. Final test type/lint checks and source whitespace checks also passed.
- Inspected the actual 390px Resume screenshot. Existing browser checks cover narrow/wide layout, keyboard navigation and reduced motion. Personal Chrome/profile was untouched in Phase 8. Provider credentials were neither read nor changed. Source changes remain uncommitted.

### Limits and next phase

- One action per Start remains. Final evidence-based goal assessment is Phase 9; finish still requests assessment rather than claiming task completion. Resume and reconnect do not autonomously start remaining actions.
- There is no universal exactly-once guarantee for website effects. A claimed action whose result/cache is lost can remain uncertain, especially after document loss. Inspect the website and Stop that task if it cannot be reconciled. Stop cannot undo effects already dispatched.
- Resume retains the original deadline (default ten minutes from task creation) and all attempt/budget limits. Storage corruption or quota failure blocks new dispatch. General-site synthetic-input compatibility and successful native toolbar screenshot capture retain the previously documented limits.

## Phase 7 — complete (2026-10-29)

- Enabled normal HTTP(S) pages through optional Chrome host permission plus separate exact-origin app consent. No broad tab metadata/debugger permission or automatic content injection was added. The worker checks access on binding, observation, execution and navigation; revocation stops content/navigation and invalidates the session. Cross-origin destinations need their own grant. Privileged/credential/secret-bearing URLs are rejected.
- Added independent browser policy and two-minute exact-action review. Normal-site clicks, edits, selections and keys conservatively require review because event handlers may save/transmit immediately. Known safe fixture interactions retain the fast path. Passwords, payment/PII fields, recognizable secret input, sensitive forms, private controls and detected CAPTCHA/access challenges remain blocked.
- `content_prepare` fingerprints exact action/verification, document/session/observation/revision, target and local form values without dispatch. Only the digest and sanitized description leave content. Execution rechecks the fingerprint/freshness, consumes approval once and dispatches synchronously. DOM/form changes (including property-only value changes), changed action parameters, Stop, rebinding and expiry invalidate approval. Backend review checkpoints bind the challenge to pending authorization and record approval; model risk cannot grant consent.
- Production setup-token exchange now issues an origin-bound paired session. Private atomic `.data/pairing.json` stores hashes only; rotation/revocation survive restart. Production task APIs reject setup credentials, missing/wrong origins and browser-origin/header mismatches. Pairing has bounded attempts and JSON payloads. The shipped server always enables pairing; isolated test servers retain an explicitly injected direct-token adapter. Extension local storage is restricted to TRUSTED_CONTEXTS.
- Screenshots additionally omit visible iframe/canvas/video/embedded content and populated text fields. Existing bounded DOM/token/email/card filtering remains. Recognizable private instructions and unsanitized alternate model context are rejected before inference. These heuristics are conservative, not universal sensitive-data recognition. Provider transport/model configuration and the user's .env remain unchanged.
- Reused full-plan schemas, deterministic verifier, action journals, atomic state, bounded recovery, model prompts and existing panel identity. Added shared safety/review schemas; backend pairing/privacy tests and review route; extension access service, WebsiteAccess panel and preflight; an inert normal-site test page and browser safety suite. Updated health phase, README, architecture and design notes.
- Fixed the reported permission/binding error. Native Chrome showed ClickFlow under Access requested and hid the tab URL, leaving Allow disabled. WebsiteAccess now accepts an explicit Site address when metadata is hidden, validates the actual active origin after permission, automatically binds after Allow and displays separate access/binding states. It refreshes on tab/access/session changes; already allowed stopped sites have Bind allowed site. No broad tabs permission was needed. Recovery constraints now describe the permitted-site/review boundary rather than obsolete fixture-only scope.

### Checks actually run

- Final full `npm run check` passed: 223 unit/API tests across 14 files; 54 ordinary real-extension Chromium browser tests; one actual-process restart case; two production asset/secret checks; type checks, lint and all production builds. The optional live-model browser test skipped by default. No new live-model call or external consequential operation was made.
- Real browser coverage includes production pairing via UI, consent before binding, automatic binding with hidden URL metadata, exact-origin refusal before navigation, actual reviewed click/typing with verification, decline, changed form values, changed action parameters, duplicate delivery, revocation, private-field/screenshot blocks and disconnect. Existing full-plan, recovery, Stop, extraction and history tests remain passing.
- New pure/API tests cover optional access denial/revocation, exact ports, setup/session separation, origin mismatch, private hashed persistence/restart/rotation/revocation, pairing rate/body limits, approval scope/revisions/expiry/cancellation and private model input. A test selector was tightened after both WebsiteAccess and Browser tools correctly reported Page bound; the final full suite passed.
- Responsive confirmation UI was checked at 320/390/768/1440 widths with keyboard and reduced motion. The actual confirmation screenshot was visually inspected. Native Chrome verified the missing-URL problem and the updated fallback UI; the rebuilt extension was reloaded, the user's task text restored and existing local pairing refreshed without revealing credentials. Site permission for YouTube remains the user's explicit next action; no search was run.
- Current suite has 280 distinct passing cases/checks (223 unit/API + 54 browser + 1 restart + 2 assets). Earlier live smoke results are historical and are not counted as new Phase 7 checks. Source changes remain uncommitted; useful prior work was preserved.

### Limits and next phase

- One step per Start remains. Normal-site interactions require manual review, which adds human response time but no extra model call for successful deterministic steps. General website compatibility is bounded by DOM support and synthetic input; cross-origin frames/closed shadow roots/coordinates/native debugger input are unsupported. High-risk navigation is conservatively blocked. Private/payment forms may require the user to complete them manually.
- Native Chrome optional permission acceptance and a newly granted remote site have not been automated in the user's profile. Isolated browser tests use existing loopback host access plus app consent. Successful native screenshot capture was unavailable without the toolbar activeTab grant; omission behavior passed. The fallback UI itself was verified in the user's Chrome.
- Recognizable private text is rejected, but heuristics cannot guarantee all personal information is detected. Images remain opt-in and transient. Free-provider latency/availability is unchanged.
- Unknown-dispatch reconciliation/full durable resume is Phase 8; final goal assessment is Phase 9. Pending reviews never resume automatically. Finish requests assessment and cannot claim overall completion.

## Phase 6 — complete (2026-10-28)

- Added model-assisted recovery that updates the existing plan rather than regenerating the task. The initial complete-plan flow and deterministic successful updates remain intact. Recovery receives original goal, existing/completed work, previous action/outcome/verification, recent history, fresh DOM/optional safe image, URL/title and remaining constraints.
- Reused existing action/plan-patch schemas, model configuration/transport, browser observations, journals, event polling and atomic store. Added `agent/recovery.ts`, `execution/plan-patcher.ts` and a separate synthetic live recovery smoke test. The JSON client now supports both initial plans and recovery schemas with the same capability checks and sanitized errors.
- The pure reducer requires the exact base plan version and preserves original goal criteria, completed/skipped work and valid pending steps. It rejects fabricated evidence, execution claims, selectors/references, dependency errors and risk downgrades. New IDs inherit unresolved logical attempt budgets. Fresh refs normalize to accessible targets; unresolved semantic actions remain blocked.
- Added an authenticated, idempotent POST /api/tasks/:id/recover. Reservation IDs, recovery attempts and model-call counters persist before asynchronous inference. SDK inference retries reserve additional model budget before dispatch. Action timeouts are capped by remaining task duration; default attempt/recovery/model/action/duration circuit breakers are enforced. Failed model/patch attempts consume their reservations.
- Recovery refuses unresolved prepared or uncertain dispatches. An unverified dispatched side effect cannot be replayed unchanged or moved to another step ID to evade guards. Idempotent input/observation retries remain bounded. A stale response must match the current recovery request as well as plan version before applying.
- The panel requests one update after supported failures, provides manual Recover plan for fresh-state/semantic resolution, and displays actual counters, explanations and labelled error history. Recovery itself does not dispatch; updated work requires review/Start. Stop aborts model work and late replies cannot replace cancellation. React guidance kept event handling and the existing single polling subscription responsive; no new UI dependency or permission was added.

### Checks actually run

- Full npm run check passed with 193 unit/API tests, 45 ordinary real-extension browser tests, one actual-process restart case, two production asset/secret checks, type checking, lint and builds. The opt-in live agent browser case skipped by default.
- Added one final request-identity regression afterward; reran the entire unit suite (194 passed), type checks, lint and builds. The final panel history refinement passed extension type/lint/build checks and all 10 ordinary task-runner browser cases (the same cases already included in the 45 total). No duplicate reruns are counted as additional tests.
- Unit coverage includes stale patches, completed work/goal/evidence/risk protections, insertion lineage and limits, provider retry charging, all task budgets, malformed model updates, pending/uncertain dispatch refusal, late cancellation and older recovery replies on the same plan version.
- Real browser recovery completes a safe first step, fails on a missing target, applies a validated patch preserving completed work and IDs, then verifies the second attempt under the original logical budget. Another case verifies Stop during recovery leaves the completed step intact and ignores the late patch. Existing narrow layout, keyboard and reduced-motion checks pass; the recovery screenshot was visually inspected.
- Actual live synthetic recovery smoke passed using the configured Nemotron model and a process-local 120-second deadline: a real structured patch reduced to plan v2 while preserving original IDs and attempt lineage. No browser action, stored-task mutation or user data was involved. The user's .env was neither edited nor printed.
- Current distinct passing cases/checks: 243 (194 unit/API + 45 browser + 1 restart + 2 assets + 1 separate live smoke). README and architecture document usage, quotas and limits. Build artifacts contain no backend secret sentinel. Source changes remain uncommitted.

### Limits and next phase

- Fixture-only actions, review and one step per Start remain. Automatic recovery makes one update request after a supported failure; it does not recursively call the model or dispatch an automatic retry. A stopped/unbound fixture must be explicitly rebound before fresh-context recovery.
- Unknown dispatch reconciliation/full durable resume is Phase 8; general-site origin permissions, confirmations and stronger pairing are Phase 7; final goal assessment is Phase 9. Finish remains an assessment request and cannot claim completion.
- The UI and real actions were exercised in isolated Chromium. Native Chrome screenshot success with a toolbar-issued activeTab grant was not newly verified. The live recovery smoke used synthetic DOM context; image transport retains the earlier validated implementation and privacy boundary. No performance guarantee is claimed for the free provider.

## Phase 5 — complete (2026-10-28)

- Expanded the existing action executor and authorization protocol to support observe, navigate, click, type, clear_input, select_option, scroll, press_key, wait, go_back, go_forward, extract_text and finish. Every Start still dispatches one action and updates the existing plan after verification.
- Reused shared action/verification schemas, the Phase 4 journal and task service, Phase 2 observation/privacy/target policy and event-driven verifier. Added `browser/dom-actions.ts` for native input setters and deterministic fixture key behavior, and `/fixtures/details.html` for actual document navigation tests. No dependency or website permission was added.
- Added selected-option, URL, count, scroll-baseline and text-v1 extraction verification. Wait uses DOM/input/focus/scroll events and bounded deadlines, with abort cleanup. Textarea and React-controlled-input edits are supported. Invalid/disabled options are rejected before dispatch.
- The worker handles navigation/history using Chrome APIs, exact expected URLs and fresh document binding. Only two known fixture paths on the current local origin are allowed. Back/Forward use only the recorded agent navigation trail. Stop invalidates navigation/rebinding; BFCache restoration resets references and restores observation listeners.
- Extraction is bounded and sanitized and carries outputKey, schemaId, sourceUrl, capturedAt and observationId. The backend validates record/action/source identity, persists it in action history and displays it in the panel. Older task snapshots default missing extraction to null.
- Finish records a request for completion assessment, returns unknown verification and blocks that assessment step while leaving the task paused. It never produces fabricated passing evidence or overall completion. Semantic target resolution/recovery and final goal assessment remain later phases.
- Fixed session replacement display after navigation and a queued-scroll freshness race: notifications for an already-observed scroll position no longer invalidate that snapshot, while new positions and DOM changes still invalidate references.

### Checks actually run

- Final `npm run check` passed: strict type checks, lint, 163 unit/API tests, all production builds, one actual-process restart test, two extension asset/secret checks, and 43 ordinary real-extension browser tests. One opt-in live-model test skipped as designed. Total passing cases/checks across runners: 209; no live model was called in Phase 5.
- Added real browser coverage for native/React clearing, textarea edits, select options, Enter and Backspace, counts, scrolling, delayed waits and cancellation, extraction source records, navigate/back/forward with document rebinding, finish assessment requests, unknown-history refusal, invalid options and Stop during navigation rebinding.
- A complete backend/extension workflow navigates, extracts, persists/displays the text and requests finish with one initial mocked planner call and stable step IDs. Routine successes require no extra model request or screenshot.
- Initial regression runs exposed queued scroll notifications invalidating already-current observations; this was fixed and the final entire suite passed. The added callback type error was fixed before final verification. Actual screenshots were inspected; the existing 320/390/1280px layout, keyboard and reduced-motion checks passed.
- Updated README and architecture with actions, source records, navigation boundaries and key limitations. Production assets remain free of the backend key sentinel. User .env and credentials were preserved.

### Limits and next phase

- Execution remains fixture-only and one step per Start. Keyboard actions use synthetic DOM events plus deterministic fixture editing/button behaviors; trusted OS input and universal website behavior are not claimed.
- Extraction currently supports non-empty bounded text-v1 records. Unknown schemas and unresolved semantic targets pause. General-site permissions and consequential confirmation are Phase 7; bounded plan recovery is Phase 6; final completion assessment is Phase 9.
- Unknown dispatch reconciliation and full browser resume remain Phase 8. Stop cannot undo an already-requested navigation. Successful native Chrome screenshot capture with a toolbar-issued activeTab grant was not rerun; existing omission/privacy checks pass.

## Phase 4 — complete (2026-10-28)

- Connected the installed extension task composer to fresh fixture observation, backend complete-plan generation, full review, Start next step, a real browser action, verification and a deterministic update of the same plan. Every Start executes one supported step and pauses for inspection; no automatic full-task completion is claimed.
- Reused the Phase 3 planner, Phase 2 browser/content executor and safety policy, shared schemas and atomic task store. Added `execution/task-service.ts`, `routes.ts`, `access-token.ts`, shared `task-protocol.ts`, `services/tasks.ts`, and `TaskRunner.tsx`.
- Added authenticated create/read/Start/authorize/outcome/Stop and versioned snapshot-event polling. Public health remains read-only. A separate generated local token (private `.data/extension-token`) protects model-backed routes; browser callers must be extension origins. Preview website callers are blocked. Full origin-bound pairing/revocation remains Phase 7.
- Task IDs make creation idempotent. Short state transitions serialize independently of model calls. Prepared action envelopes include task/plan/step/action/observation/attempt/lease identities and persist before dispatch. The worker journals the full envelope before calling the existing executor, rejects unknown/repeated dispatches, and caches known outcomes. A second action is blocked while an outcome is unresolved.
- Outcome processing validates matching predicates and resulting observation evidence, accepts each action ID once, preserves stable plan IDs and pending steps, increments plan versions and records actual history. Dispatch alone cannot complete a step. Stop prevents new authorization; late results do not override cancellation. Backend restart pauses interrupted work without replaying prepared actions.
- Added full ordered step review with exact parameters, actual status/progress/activity, local connection settings, optional safe screenshots, Stop and checkpoint restoration after panel reload. Existing identity/tokens were retained; no animation or automation dependency was added. Shared pendingAction defaults to null for older schema-1 snapshots.

### Checks actually run

- Full `npm run check` passed: type checks, lint, 161 unit/API tests, builds, one actual-process restart test, two production asset/secret checks, and the then-current 30 ordinary real-extension browser tests. The live browser test skipped by default as designed.
- Added two targeted journal regressions afterward. The affected browser suite passed all seven ordinary cases (including the existing five Phase 4 flows); test type checks and scoped lint passed after correcting storage typing. Across suites, 32 distinct ordinary browser cases were verified. Total passing distinct automated cases/checks including the separate live workflow: 197 (161 + 32 + 1 + 2 + 1).
- Real unpacked-extension tests cover full plan review before actions, verified focus, React typing, failure/pausing without retry, Stop during planning, stable-ID updates, panel reload, full-envelope replay without an extra click, unresolved-journal blocking, 320/390/1280px layouts, keyboard order and reduced motion. Actual screenshots were visually inspected.
- Optional real-provider integration: the first attempt hit the configured 60-second deadline; the task failed with an actionable timeout and no dispatch. A separate invocation with `MODEL_TIMEOUT_MS=120000 RUN_LIVE_AGENT=1` passed: the configured Nemotron model generated a two-step plan, one actual fixture click focused Search, verification passed, and IDs were preserved with one model call. This Phase 4 test used sanitized DOM context; earlier Phase 3 live image acceptance is recorded below. No user .env values were changed or printed.
- The original restart test was updated to assert the new safe paused checkpoint once across two actual restarts. It passes. Production asset tests confirm local entrypoints/minimal permissions and no backend key sentinel. `git diff --check` passed, .env and runtime token files remain ignored, and running health reports Phase 4 with planning/browser execution enabled.

### Limits and next phase

- Fixture-only observe/click/type execution, one step per Start. Unsupported actions, risks, unresolved semantic targets or prerequisites pause with an explanation. No model recovery, general-site permissions, consequential confirmation, final completion assessment or full interruption reconciliation is enabled. Finish remains a pending assessment step.
- Browser session state and task dispatch journal are separate. Unknown dispatches remain blocked; restoring a task never automatically executes it. Full durable resume/reconciliation is Phase 8.
- Successful native Chrome screenshot capture with a user-issued activeTab grant and toolbar/native side-panel activation in the user's own profile remain unverified. Tests use the real extension in isolated Chromium and its rendered panel page. No latency guarantee or performance percentile is claimed.
- README, architecture, design notes and environment comments describe local token setup, data transmission, endpoint protocol and test commands. Phase 5 expands action coverage and deterministic verification; Phase 6 adds bounded recovery.

## Phase 3 live verification — passed (2026-10-28)

- After the operator configured the backend `.env`, ran `RUN_LIVE_MODEL=1 npm run test:model:live` against `nvidia/nemotron-3.5-super-vl:free`.
- The actual provider accepted the synthetic image input and returned a complete three-step plan that passed runtime schema and semantic validation. Command exited successfully. No browser actions were executed and no credentials were printed.
- This verifies the configured endpoint's image transport and structured planning for this test. It does not establish general visual accuracy, autonomous browser execution or latency guarantees. Earlier skipped-test notes below describe the original Phase 3 handoff.

## Phase 3 — complete (2026-10-28)

- Reused the existing shared initial-plan/action/target/verification/observation contracts, configuration loader and strict workspace/test tooling. Existing Phase 2 changes and fixture execution were preserved.
- Added backend-only OpenAI SDK integration and `agent/model-client.ts`: configured model/base URL/key, live endpoint capability checks, JSON-schema requests, optional image content, a total deadline, bounded transient retries, cancellable backoff and normalized errors. SDK retries are disabled; no fallback model or JSON downgrade is used. Remote URLs require HTTPS.
- Added `agent/planning-input.ts`, `planner.ts`, `errors.ts`, and separate initial/update/recovery/completion templates in `prompts.ts`. Initial planning produces the full plan and rejects malformed envelopes/JSON, changed goals, execution claims, unsupported actions, invalid dependencies/logical IDs, initial selectors and invented observation refs. Future controls can use semantic descriptions. Images require fresh matching metadata and bounded base64 transport, remain transient, and are not persisted/logged.
- Added backend CLI (`npm run plan -- /absolute/input.json`) and explicitly optional synthetic vision smoke test (`RUN_LIVE_MODEL=1 npm run test:model:live`). Health reports Phase 3/backend planner; task mutation endpoints and the panel composer remain disabled until Phase 4. CLI output is a validated plan, not an executed/persisted task.
- Official OpenRouter image/structured-output docs and current model endpoint metadata were checked. The selected free model advertises image input and structured_outputs/response_format. Runtime checks repeat discovery before each plan. Custom endpoints must support the same discovery protocol, not only chat completions.

### Checks actually run

- Type checking, lint (zero warnings), 145 Vitest unit/API tests and production builds passed after the final provider-envelope validation change. This adds 43 tests covering planning/SDK requests, vision payloads, schema/semantic rejection, provider failures, capability loss, retry limits, timeout and cancellation, and configuration bounds.
- Existing 25 real unpacked-extension Chromium cases passed after integration, including actual clicks, native/React typing, Stop, privacy and side-panel controls. One actual-process persistence restart test and two extension asset/secret checks passed. Total distinct current automated cases/checks: 173 (145 + 25 + 1 + 2).
- Optional live smoke command ran and correctly printed SKIPPED; no opt-in credentialed model request was made. No root .env was present. Successful real image inference/structured generation remains unverified until the operator runs the credentialed smoke test.
- npm installation reported zero vulnerabilities. Documentation and environment examples updated. Full browser execution and model latency claims are not made.

### Limits and next phase

- Phase 3 is the independently testable backend planning layer. There is no extension-to-model upload, task review/Start loop, plan persistence from CLI, patch application, recovery execution or model completion assessment yet. Those templates are preparation for later phases.
- The backend validates metadata/encoding, not whether manually supplied pixels correspond to a real page or contain sensitive content. Phase 4 must connect the existing extension privacy/freshness boundary. Use non-sensitive data with the free provider.
- Phase 4 connects task input, fresh observation transport, initial plan storage/review, action authorization, one real verified fixture action and a deterministic update to the same plan. General-site permissions/pairing and full durable reconciliation retain their later-phase scope.

## Phase 2 — complete (2026-10-28)

- Reused the Phase 1 action/observation/verification schemas, health service, design tokens, and workspace tooling. No equivalent browser implementation existed.
- Added fixture-only command/session/result contracts, a bounded DOM observer, safe target resolver, conservative action policy, native/controlled-input typing, and event-driven verification.
- Added dynamically injected isolated content runtime, background tab/document binding, a serialized session-storage journal, duplicate-action guards, local Stop, and screenshot freshness/privacy checks. No normal website access or model planning is enabled.
- Added an explicitly manual fixture tool panel and deterministic local test page. AI task controls remain disabled. No browser data is sent to the backend.
- Added unit/privacy tests and real unpacked-extension Playwright tests. All applicable checks passed; results and limits follow.
- Preserved the existing backend task store and its schema version. Updated workspace/manifest/health milestone metadata to 0.2.0 / Phase 2; the backend still exposes health only.

### New modules and important behavior

- Shared `browser-tools.ts`: fixture URL boundary, typed panel/content commands, observations, local probe sessions, outcomes, and responses. Existing action/verification/observation contracts are reused.
- `browser/`: DOM privacy helpers, `PageObserver`, restricted `resolveTargets`/`resolveOne`, `assertSafeAction`, supported-verification checks, event-driven `waitForVerification`, and normalized errors.
- `content/`: fixed isolated `ContentRuntime` with bounded single-action execution, native setters/events for React inputs, duplicate guards, and abortable verification. No arbitrary scripts or window-message bridge.
- `background/`: `handleBrowserTool`, active tab/window/document binding, `readSession`/`updateSession` short transactions, `ScreenshotService`, permission omissions, Stop, interruption guards, and a Stop epoch preventing a slow rebind from reactivating tools after cancellation. Final cancellation is rechecked after asynchronous zoom lookup and around binding persistence.
- `FixtureTools.tsx` and its service: explicit manual actions, real observations/outcomes, local screenshot preference, session updates, and an accessible Stop row. Native extension APIs are unavailable in the web preview and are never mocked there.
- Local native/React fixture, content build configuration, Playwright configuration, browser tests, and updated README/design/architecture/environment instructions.

### Checks actually run

- `npm install`: versioned workspace lock updated; npm reported zero vulnerabilities. Added Playwright 1.64.1 and installed its managed Chromium 156 build in the test cache. No user Chrome profile was modified.
- Full `npm run check`: passed with 102 unit/API tests, the then-current 24 real-extension tests, one actual-process restart test, two extension asset checks, all workspace/test type checks, lint, and builds.
- After the final cancellation race fix, reran `npm run typecheck`, `npm run lint`, and `npm run test:browser`: passed with 25 real-extension cases. Final `npm run test:extension` also passed against the latest bundle. There are 130 distinct automated test cases/checks across the runners (102 + 25 + 1 + 2).
- Browser cases cover actual Chrome injection/document identity, bounded/private observations, native and controlled-input typing, role/label/selector/reference targeting, ambiguity, disabled/hidden/covered targets, stale references, dispatched-but-unverified clicks, delayed outcomes, cancellation, duplicate IDs, concurrent commands, consequential blocking, tab changes, reload, unsupported scripts/verification, and nested private labels.
- A slow-injection regression verifies that Stop during rebinding cannot create an unstopped replacement session. A separate targeted rerun of panel actions verified keyboard Tab order through screenshot/Observe/Stop, a visible focus ring, real focus and React typing, 320px/390px overflow bounds, and actual reduced-motion emulation.
- Screenshots: mocked tests cover successful capture, wrong-tab races, sensitive pages, changes during capture/decoding, rate bounds, oversize rejection, and permission errors. Real Chrome blocked sensitive capture and, on the safe fixture, returned the missing-activeTab permission error; the omission path passed. Successful real Chrome capture was not claimed.
- Production assets have valid local worker/content/panel entrypoints and no sentinel model secret. `git diff --check` and `npm ls --depth=0` passed. Running health reports Phase 2 / 0.2.0 with planning/execution orchestration disabled.
- Visual inspection used the actual extension-panel screenshots at desktop and 390px. The fixture tool section remains readable and its Stop row stays available within the section. Proof screenshots were copied to chat outputs.

### Current limits and next phase

- Tools are restricted to the exact local fixture URL on ports 5173/4173, without queries/fragments. Only observe, safe click, and type are executable. Normal websites and other shared action shapes remain blocked.
- Chrome toolbar invocation/native side-panel activation in the user's own Chrome was not tested. The actual unpacked extension, content runtime, and panel HTML were exercised in an isolated browser profile. A user-issued activeTab grant is needed to verify successful Chrome screenshot capture.
- Privacy filtering is conservative fixture protection, not universal sensitive-data detection. No page or image data is sent to the backend or a model.
- Local sessions use `chrome.storage.session`; they are not durable across a full browser restart. Unknown dispatches require rebinding and are not replayed. Full task reconciliation is Phase 8.
- No model planner, plan reducer, backend task orchestration/pairing/SSE, general-site permission flow, or consequential confirmation flow is enabled. Phase 3 implements model capability checks, vision/JSON integration, complete initial planning, and separate prompt templates while reusing this browser layer.

## Phase 1 — complete (2026-10-28)

- Repository inspected: only the existing `.AGENT.md` guidance was present. Preserved it unchanged; no existing application functionality was available to reuse.
- Added npm workspaces, strict TypeScript configurations, ESLint, Vitest, Vite/Tailwind/React extension build, and Express backend build.
- Added shared action/target, observation, verification/evidence, initial plan/patch, task/outcome/completion, event, and health schemas with inferred types. Task/plan revisions and logical step IDs establish future orchestration contracts.
- Added `TaskStore` and `AtomicFileTaskStore` with validated snapshots, serialized compare-and-swap saves, private files, atomic replacement, and corruption protection.
- Added backend configuration loading and a health-only loopback server. No task write or model endpoints exist.
- Added an honest setup side panel with real health checking, disabled task controls, design tokens, and minimal Manifest V3 permissions. The worker only opens the panel; it does not inspect pages.
- Added schema/storage/config/HTTP tests, production asset checks with a sentinel secret, and an actual-process backend restart test.
- Added `.env.example`, secret exclusions, `README.md`, `DESIGN.md`, and `docs/architecture.md`.

## Verification actually performed

- Runtime: Node 22.22.2 and npm 10.9.7. Installed and locked compatible dependencies; updated newly deprecated ESLint 9 to supported ESLint 10. npm reported zero vulnerabilities.
- `npm run check`: passed. This includes strict workspace and test type checking, lint with zero warnings, 74 Vitest tests across four files, all production builds, one actual-process restart test, and two extension asset checks (77 tests/checks total).
- Storage tests cover full plan/context reload, competing revision updates, concurrent creates, failed-write queue recovery, immutable goals, invalid/corrupt snapshots, and POSIX file permissions. The process test starts and gracefully stops two real backend instances using isolated storage and reloads the original task.
- Asset checks build with a non-secret API-key sentinel and verify it is absent from all generated files. Manifest/HTML references resolve to local assets; no content script, debugger, or website-wide permission is requested.
- `npm ls --depth=0`: passed without unmet dependencies. Git ignore checks confirm `.env`, runtime snapshots, build output, and installed modules are excluded.
- `npm run dev`: started the actual loopback backend and preview. Browser inspection at 320px, 390px, 768px, and 1440px verified layout and no horizontal document overflow. Keyboard navigation skips disabled task controls, reaches connection controls, and expands details with Enter. No browser warning/error logs were observed in the normal connected state.
- A bounded temporary pause of this task's backend verified checking → timeout/offline; automatic resume and a new check verified reconnection. Rebuilding shared contracts during checks caused expected dev-watcher restarts; reconnection was verified after builds finished.
- Reduced-motion CSS was inspected in the rendered page: the only transition is disabled under the media query. OS-level reduced-motion emulation was not available and was not claimed.
- A full-page 390px preview screenshot was saved as a chat output. This proves the preview state, not native extension installation.

## Checks not performed

- Chrome's unpacked-extension installation and native side-panel activation were not exercised. The production package and references were checked automatically; loading instructions are in `README.md`.
- No live model request was made: integration is intentionally Phase 3 work. No credential is needed to run this phase.
- Browser observation/execution and end-to-end agent workflows are intentionally absent until later phases.

## Phase 1 handoff (historical)

No model inference, page observation, browser action executor, plan reducer, task scheduler, pairing, SSE, recovery, or resume is implemented. Phase 2 begins with fixture-only browser observation, safe target resolution, and execution primitives. Reuse the shared contracts and storage interface instead of duplicating them.
