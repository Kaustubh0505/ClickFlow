# ClickFlow

A Chrome side-panel agent built around complete plans, sequential actions, and verified outcomes.

**Current scope: Phase 1 foundation.** The monorepo, strict shared schemas, durable local task store, read-only health API, extension build, design tokens, and setup screen are implemented. Model calls, task planning, page inspection, browser actions, recovery, and execution controls are not available yet. Disabled controls are intentional; there are no hardcoded running tasks.

## Requirements

- Node.js 22.13+ on the 22.x line (recommended), 24.x, or 26+, and npm 10+.
- Chrome 120+ for the unpacked extension.
- No API key is needed for Phase 1.

## Install and run

From this repository root:

```sh
npm install
cp .env.example .env
npm run dev
```

Backend: `http://127.0.0.1:3001/api/health`.
Side-panel development preview: `http://127.0.0.1:5173/sidepanel.html`.

The preview uses the real health API. Start/restart the backend, then use **Check connection** to see its actual availability. No webpage or task data is collected.

`npm run dev` builds shared contracts once and watches both apps. After changing shared schemas, run `npm run build -w @clickflow/shared` and restart development. Do not load the Vite development directory as an extension: Chrome's CSP requires the production build with local scripts.

## Build and load the extension

```sh
npm run build
npm start
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `apps/extension/dist` inside this repository.
4. Pin ClickFlow if desired and click its toolbar icon to open the panel.
5. After code changes, rebuild and press Reload on the extension card.

Production backend startup uses compiled files and also initializes/validates the durable store. It works without model credentials. The extension uses port 3001; changing the backend port currently also requires changing the extension endpoint and manifest CSP.

## Configuration

Copy `.env.example` to `.env`; never commit it. Existing process environment variables take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODEL_API_KEY` | empty | Backend-only secret, used from Phase 3 onward |
| `MODEL_BASE_URL` | `https://openrouter.ai/api/v1` | Trusted provider configuration |
| `MODEL_NAME` | `nvidia/nemotron-3.5-super-vl:free` | Explicit model selection; never silently replaced |
| `PORT` | `3001` | Backend loopback port |
| `DATA_DIR` | `.data` | Atomic task snapshot directory, relative to repository root |

Do not prefix secrets with `VITE_`. Setting a key does not activate inference in this phase. Provider capabilities, current vision/JSON support, and a live non-sensitive smoke test will be checked in Phase 3. Free-model latency/availability is not guaranteed.

## Verification commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:restart
npm run test:extension
# All of the above, in order:
npm run check
```

- Unit/HTTP tests use local fixtures and temporary storage, never real websites or provider calls.
- Restart tests start and stop actual backend processes using an isolated directory and OS-assigned ports, then reload the original task.
- Extension build checks build with a non-secret sentinel API key, then verify local entrypoints, minimal permissions, and absence of the key from all output assets. They do not prove that Chrome loaded the extension.
- No live-model or installed-browser automation tests are present yet; those belong to later phases.

## Structure

```text
apps/backend/src/      Express health API, configuration, atomic task storage
apps/extension/src/    React side panel, health service, minimal panel opener
packages/shared/src/  Strict schemas and inferred TypeScript types
tests/                Shared fixtures, backend restart and build checks
docs/architecture.md  Ownership, contracts, state lifecycle, security boundaries
DESIGN.md             Visual tokens, layout, states, motion contract
progress.md           Actual implementation/check status and next steps
```

## Storage and limitations

The store accepts validated task objects through its TypeScript interface; there is intentionally no public write endpoint before pairing and orchestration exist. The versioned `.data/tasks.json` file is private on POSIX and ignored by Git. Writes are serialized in one backend process and use file sync, atomic rename, and directory sync. Corrupt state is preserved and causes startup to fail. Back up the file before attempting manual recovery; do not delete it to conceal errors. Multiple simultaneous backend writers are unsupported.

Shared schemas define actions without implementing them. They cannot prove that evidence is true, redact arbitrary page content, or authorize risky actions. Runtime observation, verification, confirmation, pairing, and safe resume remain future phases. No user tab access is requested in this build.

## Troubleshooting

- **Backend offline:** start `npm run dev` or `npm run build && npm start`, check port 3001, then retry the connection.
- **Port already in use:** stop the other local process or change configuration and the extension's endpoint/CSP together. Preview CORS currently permits port 5173 only.
- **Shared package not found:** run `npm run build -w @clickflow/shared`; the root commands already do this.
- **Extension will not load:** choose the built `apps/extension/dist`, use supported Chrome, and inspect `chrome://extensions` for errors. Do not point Chrome at source files.
- **Invalid configuration:** the error names invalid fields without printing secrets; compare them to `.env.example`.
- **Invalid stored state:** preserve the snapshot, check its schema version, and restore a known-good backup. There is no automatic destructive reset.

See `progress.md` for checks actually performed and outstanding work. No publication or deployment is included.
