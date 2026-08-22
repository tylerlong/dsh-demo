# dsh-demo — DeepSeek Harness as standalone scripts

Drives the DeepSeek Harness (DSH) from two plain Node scripts instead of
browser tabs or the `dsh` CLI, exercising per-agent model routing and subagent
orchestration. Both scripts are **standalone and fully project-local**: no
Cordis plugin shape, no `dsh --profile`, no profile directory, and **no reads
from `~/.dsh` at all** — every harness-home path is redirected to a
project-local file/dir by a patch layer in `src/boot.ts`.

## The demo workflow (exactly as specified)

```
primary agent  (deepseek/deepseek-v4-flash-0731, openrouter)
   │
   ├─ starts agent A (openai/gpt-5.6-luna, openrouter)
   │     → generates a random integer 1–100 (via a real random source)
   │     → returns it to the primary
   │
   ├─ deterministic branch on parity (script logic, not an LLM decision)
   │
   ├─ odd  → starts agent B (deepseek/deepseek-v4-flash-0731)
   │          computes n × 9  → writes b.txt in the project folder
   │
   └─ even → starts agent C (openai/gpt-5.6-luna)
               computes n × 10 → writes c.txt in the project folder
```

The primary agent then receives the result and confirms the written file, so
"primary agent gets the result from agent A" holds in the DSH sense: A/B/C are
all subagents of the primary, each on its own model.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | **Demo 1** — the script above: primary + A/B/C with per-agent `subagents.start('spawn', ...)` calls. `pnpm demo`. |
| `src/enhanced-flow.ts` | **Demo 2** — generic "task + review loop". `pnpm enhanced`. |
| `src/boot.ts` | Shared standalone boot: resolves the `@deepseek-ai/dsh-base` bundle, boots the tree via `boot()`, points bare-module resolution at the DSH monorepo's pnpm virtual store, and applies a **local patch layer** redirecting every `~/.dsh` read to a project-local file. |
| `root.cordis.yml` | Empty plugin list — the tree is composed purely from the base bundle patches; it is the root include each script boots. |
| `settings.yaml` | **Project-local copy** of the harness settings (openrouter provider + models, `apiKeyEnv`). No secrets. |
| `.credentials.yaml` | **Project-local credential store** (the OpenRouter key). Gitignored, mode 0600. |
| `.dsh-sessions/` | Project-local session logs (created on first run). Gitignored. |
| `package.json` | `link:` deps to the DSH monorepo packages, `tsx` SDK dev deps, `demo` / `enhanced` scripts. |
| `tsconfig.json` | Typecheck config (`pnpm typecheck`). |

## How a standalone script boots (fully local)

Neither script is a plugin — there is no `name`/`inject`/`apply` export and no
`cordis.patch.yml` mount. Each is a plain entry point that composes the tree
itself via `src/boot.ts`:

1. resolve the `@deepseek-ai/dsh-base` bundle from the DSH installation anchor
   (its patch lists the full base plugin set: agents, sessions, llm-pi-ai
   openrouter route, fs/bash/subagent tools, subagent service);
2. load that bundle's overlay patches;
3. append a **local patch layer** — id-targeted config overrides that redirect
   every harness-home read to this project: `settings` → `./settings.yaml`,
   `credentials` → `./.credentials.yaml`, `session-persistence-jsonl` →
   `./.dsh-sessions`, plus `dshHome` overrides for agent-instructions,
   skill-filesystem, attachment-local, shell-env;
4. call `boot("...", root.cordis.yml, patches, prepare)` — the public API
   `@deepseek-ai/dsh-app-boot` exports for exactly this kind of embedding;
   with `bareModuleBaseUrl` pointed at the DSH monorepo's
   `node_modules/.pnpm/node_modules`, every bare `@deepseek-ai/*` specifier
   resolves from the installation's own virtual store — **no `~/.dsh/profiles`
   flat fallback, no profile directory**;
5. provide `cmdlineArgs` + `appExit` (the same host values the CLI would).

Then the script drives `agents` / `sessions` / `subagents` straight off the
returned context, exactly like the driver plugin did — only now it owns the
boot and exit itself.

### Why this is standalone

The `llm-pi-ai` adapter is **mounted dormant**: the OpenRouter route doesn't
exist until a `llm-pi-ai.providers.openrouter` section supplies it, and keys
resolve per request through `apiKeyEnv`. Both of those now come from
**project-local** files (`settings.yaml` + `.credentials.yaml`), so the
scripts need nothing under `~/.dsh`. The only dependency is the DSH
installation itself (the harness) — which is inherent, since these scripts
*are* DSH programs.

## Demo 1 — `src/index.ts`

```bash
cd /Users/tyler.liu/src/ai/dsh-demo
pnpm demo     # = tsx src/index.ts
```

## Demo 2 — `src/enhanced-flow.ts` (task + review loop)

A task-agnostic driven loop (e.g. review a document, then close the loop on
feedback). The **task is user input** — never hardcoded, never from config or
env. The task + requirements come from the user at runtime, one of two ways:

- **an input file** given as the first non-flag CLI argument — line 1: task,
  line 2: requirements (works non-interactively, e.g. piped/scripted runs);
- **an interactive prompt** on stdin (`TASK:` / `REQUIREMENTS:`), only when
  stdin is a real terminal; on a pipe/redirect (non-TTY) with no input file it
  throws a clear error instead of hanging.

Then:

1. The **primary** agent (default `deepseek/deepseek-v4-flash-0731`) does the
   task from the resolved task + requirements and writes artifacts to
   `outputDir`.
2. A **brand-new reviewer** sub-agent (default `openai/gpt-5.6-luna`, fresh
   `spawn` — no access to the primary's context/logs of *how* it worked) gets
   the same task + requirements + the final artifacts, and returns structured
   feedback (`{"feedbacks": [{issue, suggestion}]}`). It is restricted to
   read-only tools (`read`, `read_image`, `glob`, `grep`) and never redoes the
   task.
3. The **primary adjudicates** each feedback (accept → fix/adjust the
   artifacts with write/edit; reject → keep as-is) and replies with one
   machine-parseable line `{"accepted": [ids], "rejected": [ids]}`.
4. If any feedback was accepted, the loop **restarts with a brand-new
   reviewer** against the fixed artifacts; it stops when the reviewer has no
   feedback or every feedback was rejected.

Loop control, per-agent models, and context isolation are code-level concerns.
Optional CLI flags (everything has a default):

| Flag | Meaning | Default |
|---|---|---|
| `[input-file]` | first non-flag arg: line 1 = task, line 2 = requirements | interactive prompt (TTY) |
| `--output-dir DIR` | where the primary writes artifacts and reviewers inspect | `process.cwd()` |
| `--max-rounds N` | safety cap on review rounds | `5` |
| `--timeout-ms N` | abort the run after N ms (none by default) | none |
| `--primary-model M` | model for the primary agent | `deepseek/deepseek-v4-flash-0731` |
| `--reviewer-model M` | model for every reviewer | `openai/gpt-5.6-luna` |

```bash
cd /Users/tyler.liu/src/ai/dsh-demo
# non-interactive: task from an input file (line 1: task, line 2: requirements)
printf 'Write a haiku about the sea into a file named poem.txt\nmust follow 5-7-5 and contain "waves"\n' > /tmp/task.txt
pnpm enhanced /tmp/task.txt --output-dir /tmp/enhanced-demo --max-rounds 3 --timeout-ms 300000
# interactive (real terminal): the script asks "TASK:" / "REQUIREMENTS:"
pnpm enhanced
```

## Realtime output & timeouts

- **Realtime progress** — each script subscribes to the live `session/event`
  firehose (filtered to each agent's session) and prints the token stream as
  it happens, prefixed per agent, plus `→ tool bash` lines each time the agent
  calls a tool.
- **Timeout** (enhanced) — pass `--timeout-ms N` and the run is given an
  `AbortSignal.timeout(...)` shared by every agent; on expiry the active child
  is cancelled and the script exits `1` with a clear message instead of
  hanging.

## Verified results

- **Demo 1** odd: random 63 → agent B computed `63 × 9 = 567` → `b.txt` =
  `567`; primary confirmed the file. Also 45→405, 47→423, 57→513, 73→657 on
  earlier runs. Even: 50→500, 44→440 (→ `c.txt`). Process exits 0.
- **Demo 2** (input file + `--max-rounds 3`): primary wrote
  `/tmp/enhanced-demo/poem.txt`; reviewer returned no feedback → "converged",
  exit 0.
- Non-TTY run of `pnpm enhanced` with no input file errors cleanly (exit 1) —
  no hang.

## Notes / gotchas found along the way

- `structured_output` is the child's structured-result tool; the prompt MUST
  explicitly demand calling it, or the model answers in plain text and the
  child is scored `error` (no captured value).
- LLMs are bad at "pick a random number" (a tiny biased set like {47,57,73}
  comes back). Agent A is therefore told to run
  `node -e "console.log(Math.floor(Math.random()*100)+1)"` via the bash tool —
  still the subagent generating the number, but genuinely random.
- Each child run must be `dispose()`d after settling, or the child keeps the
  process alive past the force-exit.
- The scripts boot their own tree via `boot()` and own `process.exit`; the
  `appExit`/`cmdlineArgs` host values are provided by `provideCmdline` in
  `src/boot.ts`, not by the CLI.
- Relative imports use the `.ts` extension (tsx at runtime needs it), so
  `tsconfig.json` sets `allowImportingTsExtensions` (fine under `noEmit`).
- The OpenRouter key lives in the project-local `.credentials.yaml`
  (gitignored, mode 0600). It is resolved by the `credentials` service
  through `apiKeyEnv: OPENROUTER_API_KEY` — the same mechanism the harness
  home used, now pointed at the project file by the local patch layer in
  `src/boot.ts`. To rotate the key, edit `.credentials.yaml` (or set
  `OPENROUTER_API_KEY` in the process env, which wins).