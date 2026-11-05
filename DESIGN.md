# ClickFlow design foundation

## Phase 9 direction

Preserve the evergreen field-notebook identity for a compact operational workspace. The audience needs to review a plan, identify the current action, stop it, and inspect sources. Keep the existing system font, semantic colors, 4px spacing rhythm and local SVG mark. Use a small labeled progress meter based on persisted verified steps; never estimate model progress. Order the task area as input/controls → current state/page → result and criterion citations → ordered plan → activity/evidence. Put model/endpoint and bounded new-task limits in a keyboard-accessible Settings disclosure, linked from the header. Show partial, missing, cancelled and failed outcomes explicitly. Source links and timestamps wrap at 320px. Evidence and long parameters use native details. Stop stays reachable; no motion library or new animation is needed. The existing 100ms color transition retains its reduced-motion override. Inspect 320/390/768/1440 widths, long content, source expansion, keyboard focus and reduced motion in the actual extension test profile.

## Phase 8 additions

Keep the existing compact panel identity. Add a quiet execution-checkpoint region beside the real task controls: connected/offline state, pending Stop delivery, journal phase, expected page and explicit tab relink. Resume observes/reconciles; Start remains a separate action. Restored consent is never represented as approval. Use readable text for uncertainty and exhausted budgets, without animated or invented progress. Preserve keyboard order and narrow layouts; histories report original uncertain dispatch separately from fresh state verification.

## Phase 7 additions

Preserve the existing field-notebook palette and compact single-column panel. Put Website access before task input so site scope is visible before context is transmitted. Pairing stays under Local backend connection. Show a warm amber review card only for an actual pending challenge, with origin, target/reasons, exact action, Approve and Decline/Stop controls. No countdown animation or fake progress. Permission, review, expiry and failure states use text as well as color. Long origins/actions wrap at narrow panel widths; controls remain reachable by keyboard and reduced motion. No new UI dependencies or remote assets are needed.

## Purpose and direction

ClickFlow is a compact browser-side workspace for people delegating research and routine website interaction. Its primary future interaction is reviewing a complete plan before starting execution. Observed outcomes and explicit user control matter more than decorative activity.

Choose a quiet, light field-notebook direction: warm off-white canvas, evergreen actions, muted olive supporting surfaces, compact typography, and small numbered steps. A dark terminal direction was considered but would make ordinary browser tasks feel more technical than necessary. The distinctive motif is a small branching path mark paired with numbered execution steps.

Phase 2 adds a clearly labeled manual browser lab below the task composer. The task field and Generate plan button remain disabled and explained because model planning is Phase 3. The lifecycle list describes intended behavior; it must never resemble a running or completed task. Backend health and fixture outcomes are real observations, not simulated progress.

## Tokens

The source of truth is `apps/extension/src/sidepanel/styles.css`, using Tailwind 4 `@theme` variables.

| Role | Value |
| --- | --- |
| Canvas / surface | `#f8f9f6` / `#ffffff` |
| Primary text / secondary text | `#172d27` / `#52645b` |
| Action / border | `#205b43` / `#dce3dc` |
| Supporting surface | `#eef2e9` |
| Focus outline | `#528160`, 3px, 4px offset |
| Body / detail text | 14px / 11–12px |
| Heading | 24–30px fluid, 1.18 line height |
| Typeface | System sans; no remote font dependency |
| Spacing rhythm | 4px base; 20px outer gutters; 24px section gaps |
| Radius | 6px controls; 10–12px panels |
| Depth | Single restrained composer shadow |

## Layout and states

- One column, 280px minimum viewport and 480px maximum content measure. Validate at 320px, 390px, 768px, and desktop widths.
- Header → real connection status → product purpose → disabled task composer → manual fixture tools → lifecycle preview → connection details → footer.
- Preserve this reading and keyboard order. Long model names wrap. Use system fonts and local SVG markup only.
- Primary buttons: enabled evergreen, hover darker, visible focus, pressed immediate, disabled pale with explicit explanation. Fixture controls use quieter outlined buttons; Stop uses rust text and a pale rust surface. The Observe/Stop row stays visible within the tool section while scrolling.
- Connection: checking (neutral), connected (green), offline (rust), always accompanied by text. Announce changes through a polite status region.
- Future execution statuses must use icons/text as well as color; each step must expose action, outcome, and evidence separately. Never invent progress or substitute a spinner for a real state.
- Native `details` provides connection disclosure with keyboard behavior. There is no settings dialog in this phase.
- Outside the installed extension, show a truthful capability notice and a fixture link. Do not substitute browser mocks or enable non-functional tool buttons in the web preview.
- The installed lab exposes real session binding, user-entered non-sensitive test query, screenshot preference, dispatch state, verification outcome, bounded observation, and an optional transient screenshot. Distinguish dispatched from verified and never imply manual fixtures are an AI plan.

## Motion

Only a 100ms color transition on the connection button. No motion library, animated loader, entrance choreography, or delay before controls become usable. Reduced motion disables that transition. No recurring animation or layout motion.

## Review requirements

Inspect the actual preview at narrow and wide widths, exercise keyboard focus and the connection check, inspect reduced motion, and check for overflow. A preview is not proof of an installed extension. Native side-panel operation and browser observation belong to later integration checks. Record actual evidence and limitations in `progress.md`.

## Phase 4 plan review and execution

Preserve the cream/evergreen identity and existing typography. The primary card now contains a local-connection disclosure, task input, explicit model-data explanation, full ordered plan and actual checkpoint/activity state. Generate precedes review and Start. Start advances one safe step; Stop stays in the sticky controls row. Exact action/verification parameters are available in expandable step details. Status changes use text and color with immediate updates; no new animation library is needed. Native details/buttons retain keyboard operation and reduced-motion behavior. Test widths are 320, 390 and 1280px.
