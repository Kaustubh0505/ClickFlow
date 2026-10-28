# ClickFlow design foundation

## Purpose and direction

ClickFlow is a compact browser-side workspace for people delegating research and routine website interaction. Its primary future interaction is reviewing a complete plan before starting execution. Observed outcomes and explicit user control matter more than decorative activity.

Choose a quiet, light field-notebook direction: warm off-white canvas, evergreen actions, muted olive supporting surfaces, compact typography, and small numbered steps. A dark terminal direction was considered but would make ordinary browser tasks feel more technical than necessary. The distinctive motif is a small branching path mark paired with numbered execution steps.

Phase 1 renders a setup/empty state only. The task field and Generate plan button are explicitly disabled and explained. The lifecycle list describes intended behavior; it must never resemble a running or completed task. The only live product interaction is a real backend health check and expandable connection details.

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
- Header → real connection status → product purpose → disabled task composer → lifecycle preview → connection details → footer.
- Preserve this reading and keyboard order. Long model names wrap. Use system fonts and local SVG markup only.
- Primary buttons: enabled evergreen, hover darker, visible focus, pressed immediate, disabled pale with explicit explanation. Phase 1 exposes only disabled Generate plan and enabled Check connection.
- Connection: checking (neutral), connected (green), offline (rust), always accompanied by text. Announce changes through a polite status region.
- Future execution statuses must use icons/text as well as color; each step must expose action, outcome, and evidence separately. Never invent progress or substitute a spinner for a real state.
- Native `details` provides connection disclosure with keyboard behavior. There is no settings dialog in this phase.

## Motion

Only a 100ms color transition on the connection button. No motion library, animated loader, entrance choreography, or delay before controls become usable. Reduced motion disables that transition. No recurring animation or layout motion.

## Review requirements

Inspect the actual preview at narrow and wide widths, exercise keyboard focus and the connection check, inspect reduced motion, and check for overflow. A preview is not proof of an installed extension. Native side-panel operation and browser observation belong to later integration checks. Record actual evidence and limitations in `progress.md`.
