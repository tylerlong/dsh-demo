# harness-workflow

A local web app that runs one submitted task on two AI models concurrently so they can be compared side by side. Each run continues a **session** from the shared DSH store and spans two **lanes** (one model per lane) over the resumed session's **workspace**.

[`examples/`](examples/README.md) holds archived pre-product DSH-harness demo scripts (each with its own frozen boot copy and the legacy `dsh-demo` name); they are not part of `harness-workflow`.

## What it does

- **Session browser.** The left panel lists workspaces from the shared DSH store, each expandable to its sessions — labeled by each session's stored title (else a minimal placeholder), ordered newest-first and capped at the top 3 per workspace, with subagent sessions filtered out. It is read-only, loaded once on page load, never auto-reloaded; the latest session is preselected and the selected row is highlighted.
- **Continue, don't restart.** Clicking a session opens it in the right panel; submitting resumes that session — the primary agent inherits its saved context and the run's new turns append to the same session. The task field starts empty; submit is disabled until a session is selected.
- **Two models, one task, side by side.** The **primary model** drives a run that spawns one read-only worker per lane on its lane's model. The right panel shows the selected session's own recent ~100-line window read from the store — primary-only, with input (user-role) and output (assistant-role) in distinct backgrounds and tool/step/system lines in the default style. The two lane workers appear live only while the run is in progress; once stored they are not loaded.
- **Workspace from the resumed session.** The workspace is the resumed session's cwd (from its header), not a form selection — the workspace dropdown is removed. The shared DSH workspace catalog is still read read-only. See ADR-0003 and ADR-0006.
- **Per-run cancel with concurrent runs.** Cancel aborts only the viewed session's run; other sessions keep running server-side in the store, and switching away and back is a fresh store read.
- **No comparison summary.** The orchestrator coordinates the two workers and ends the run once both lanes settle; it never produces a summary.

## Run

```sh
pnpm install      # once — installs @deepseek-ai/* against the DSH monorepo
pnpm serve        # builds the frontend, then boots the harness and serves the UI
```

The server binds `127.0.0.1:4173` by default (override with `HARNESS_WORKFLOW_PORT`) and prints its URL — open it in a browser.

`pnpm serve` builds the React frontend (`vite build web`, output `web/dist`) and then boots the **shared harness** (see `src/boot.ts`): it reads the shared harness home (`~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml`, `~/.dsh/sessions`) and resolves every `@deepseek-ai/*` plugin from the DSH monorepo's pnpm virtual store, so the product shares settings, the session store, and the workspace catalog with DSH web (see ADR-0003).

## Develop

```sh
pnpm dev          # runs the backend and the Vite dev server together
```

`pnpm dev` starts the backend and the Vite dev server concurrently. The dev server proxies the API routes (`/api/*`) and the WebSocket endpoint to the backend, so the browser talks to one origin and gets hot reload. The dev proxy honors the same `HARNESS_WORKFLOW_PORT` override the backend reads.

## Project layout

| Path | Purpose |
|---|---|
| `src/server.ts` + `src/serve.ts` | **harness-workflow** — an HTTP + WebSocket server serving the built React frontend (`web/dist`) as a generic static file server, plus the `/api/models` and `/api/sessions` endpoints. Model dropdowns populate at runtime from the harness's configured provider settings (`llm-pi-ai`); the session tree from the shared store. `pnpm serve`. |
| `src/boot.ts` | Shared product boot: resolves the `@deepseek-ai/dsh-base` bundle, boots the tree via `boot()` with the `harness-workflow` identity, points bare-module resolution at the DSH monorepo's pnpm virtual store, and mounts the shared storage stack. |
| `src/run-factory.ts` / `src/real-run-factory.ts` | The single run-factory seam: tests inject a scripted fake; `serve.ts` wires the harness-backed factory. |
| `src/model-list.ts`, `src/session-tree.ts`, `src/harness-adapters.ts`, `src/workspace.ts` | Adapters from the harness's llm registry / shared workspace registry and session store to the UI rows (the read-only workspace→session tree), the typed context wiring, and workspace resolution. |
| `shared/protocol.ts` | The one shared WebSocket contract (run request shape, run event union, lane identity, WS path constant), imported by both the server and the client so the contract cannot drift. |
| `web/` | The TypeScript + Vite + React single-page application: the app shell, the read-only session browser (left panel: workspace→session tree), the run configuration form and transcript (right panel), model selectors, the lane component, and the `useRun` lifecycle hook. Styled with Tailwind. |
| `root.cordis.yml` | Empty plugin list — the tree is composed purely from the base bundle patches. |
| `storage.cordis.patch.yml` | The overlay that mounts the shared storage stack for the workspace catalog. |
| `examples/` | Archived pre-product DSH-harness demo scripts — see [`examples/README.md`](examples/README.md). |

## Docs

- `CONTEXT.md` — the product's domain vocabulary.
- `docs/adr/` — recorded decisions (ADR-0001 transport & run model, ADR-0002 workspace as the orchestrator's session cwd, ADR-0003 shared workspace catalog, ADR-0004 the codebase simplification, ADR-0005 the frontend rewrite, ADR-0006 the session browser and resume-not-create).
