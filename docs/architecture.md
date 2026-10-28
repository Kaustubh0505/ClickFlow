# Phase 1 architecture

## Boundaries

`apps/extension` owns browser-facing UI and, in later phases, observation, permission checks, execution, verification, and a local dispatch journal. Its current service worker only configures the toolbar to open the side panel. No content script is installed and no user page is read.

`apps/backend` owns configuration, persistence, and the future orchestrator/model client. Phase 1 exposes only `GET /api/health`. It does not expose task reads/writes or call a model. Requests from unrelated browser origins are rejected; full extension pairing must precede future task endpoints. Health access from an extension origin is not authentication.

`packages/shared` is a browser-safe, Zod-only runtime contract package. Both apps consume its built ESM and declarations. No Node APIs, environment variables, backend configuration, or secret values enter this package. Source imports use `.js` extensions for Node ESM compatibility. Build shared before consumers; rebuild shared and restart development servers after changing contracts.

## Shared contracts

- Actions are strict discriminated unions with bounded parameters. All MVP action shapes are defined; browser implementation is deferred. Coordinate, debugger, arbitrary JavaScript, and tab-switch actions are absent.
- Targets allow observation-bound references, roles, labels, selectors, text, and semantic descriptions. Semantic descriptions are permitted for unobserved future pages. Selectors are data for a future fixed DOM resolver, never executable JavaScript.
- Plans contain goal criteria, stable step IDs, logical step IDs, typed verification, risks, dependencies, evidence IDs, and a revision. Initial plans must be entirely pending and version 1. Validate unique IDs, acyclic dependencies, at most one active step, and a final finish step depending transitively on all work.
- Logical step IDs will retain retry budgets through recovery replacements. Patch shapes reject conflicting step changes and invented execution claims. Applying patches against actual state, rejecting stale patches, and preserving completed work are Phase 6 responsibilities, not implemented reducers in Phase 1.
- Observations are bounded, document-scoped snapshots. Their persisted screenshot field contains metadata only. Input values and raw image data are deliberately absent; future execution/transport must gate any necessary values or image bytes separately. Strict schema validation cannot identify all sensitive content in visible text: runtime filtering remains Phase 2/7 work.
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

Root `.env` is loaded on the backend only, with process environment taking precedence. Missing keys are allowed because Phase 1 has no inference. The configured model is reported without a key or provider URL. Configuration failures list field names, never their values.

The server binds only to `127.0.0.1`. The extension requests `sidePanel` and loopback backend access only, with a restrictive local CSP. Tab access, scripting, broad website access, and debugger permission are not requested prematurely. Chrome host match patterns cannot be restricted to a port, so CSP limits connection to port 3001. Changing backend port requires updating both the extension endpoint and CSP in this phase.

## Verification layers

Vitest covers contracts, configuration, storage, and actual HTTP health behavior. Separate Node tests inspect production extension assets and launch/stop two real backend processes against the same stored task. Preview visual checks validate layout and health interaction only; installed-extension and live-model operation must be reported separately.
