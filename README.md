# harness-workflow

A local web app that runs one submitted task on two AI models concurrently and streams both results live so they can be compared side by side. Each run spans two **lanes** (one model per lane) over a **workspace** chosen from the shared DSH workspace catalog.

[`examples/`](examples/README.md) holds archived pre-product DSH-harness demo scripts (each with its own frozen boot copy and the legacy `dsh-demo` name); they are not part of `harness-workflow`.

## What it does

- **Two models, one task, side by side.** Submit a task; the **primary model** drives a run that spawns one read-only worker per lane on its lane's model. Both lanes stream text/tool output live, so you watch the same task run on two models at once and compare.
- **Per-tab runs.** Each browser tab owns its run; a submit carries the task, the primary model, the two lane models, and the chosen workspace. Closing or refreshing a tab cancels only that tab's run.
- **Workspace from the shared catalog.** The workspace dropdown is seeded from the shared DSH workspace catalog (owned by DSH web), read read-only; the run's orchestrator gets that folder as its session cwd and workers inherit it. See ADR-0003.
- **No comparison summary.** The orchestrator coordinates the two workers and ends the run once both lanes settle; it never produces a summary.

## Run

```sh
pnpm install      # once — installs @deepseek-ai/* against the DSH monorepo
pnpm serve        # boots the harness and serves the UI
```

The server binds `127.0.0.1:4173` by default (override with `HARNESS_WORKFLOW_PORT`) and prints its URL — open it in a browser.

`pnpm serve` boots the **shared harness** (see `src/boot.ts`): it reads the shared harness home (`~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml`, `~/.dsh/sessions`) and resolves every `@deepseek-ai/*` plugin from the DSH monorepo's pnpm virtual store, so the product shares settings, the session store, and the workspace catalog with DSH web (see ADR-0003).

## Project layout

| Path | Purpose |
|---|---|
| `src/server.ts` + `src/serve.ts` | **harness-workflow** — an HTTP + WebSocket server serving a static comparison UI from `public/`: a top section (task, primary model dropdown, Submit/Cancel, output) above two lanes (dropdown + output panel each). Model dropdowns populate at runtime from the harness's configured provider settings (`llm-pi-ai`); the workspace dropdown from the shared catalog. `pnpm serve`. |
| `src/boot.ts` | Shared product boot: resolves the `@deepseek-ai/dsh-base` bundle, boots the tree via `boot()` with the `harness-workflow` identity, points bare-module resolution at the DSH monorepo's pnpm virtual store, and mounts the shared storage stack. |
| `src/run-factory.ts` / `src/real-run-factory.ts` | The single run-factory seam: tests inject a scripted fake; `serve.ts` wires the harness-backed factory. |
| `src/model-list.ts`, `src/workspace-list.ts` | Adapters from the harness's llm registry / shared workspace registry to the UI dropdown rows. |
| `public/` | Static UI assets (the document, stylesheet, and browser script) served from disk per request. |
| `root.cordis.yml` | Empty plugin list — the tree is composed purely from the base bundle patches. |
| `storage.cordis.patch.yml` | The overlay that mounts the shared storage stack for the workspace catalog. |
| `examples/` | Archived pre-product DSH-harness demo scripts — see [`examples/README.md`](examples/README.md). |

## Docs

- `CONTEXT.md` — the product's domain vocabulary.
- `docs/adr/` — recorded decisions (ADR-0001 transport & run model, ADR-0002 workspace as the orchestrator's session cwd, ADR-0003 shared workspace catalog, ADR-0004 the codebase simplification).
