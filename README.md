# dsh-demo — DeepSeek Harness as a script

Drives the DeepSeek Harness (DSH) from a plain CLI command instead of browser
tabs, exercising per-agent model routing and subagent orchestration.

## The workflow (exactly as specified)

```
primary agent  (~deepseek/deepseek-v4-flash-latest, openrouter)
   │
   ├─ starts agent A (openai/gpt-5.6-luna, openrouter)
   │     → generates a random integer 1–100 (via a real random source)
   │     → returns it to the primary
   │
   ├─ deterministic branch on parity (script logic, not an LLM decision)
   │
   ├─ odd  → starts agent B (~deepseek/deepseek-v4-flash-latest)
   │          computes n × 9  → writes b.txt in the project folder
   │
   └─ even → starts agent C (openai/gpt-5.6-luna)
              computes n × 10 → writes c.txt in the project folder
```

The primary agent then receives the workflow result and confirms the written
file, so "primary agent gets the result from agent A" holds in the DSH sense:
A/B/C are all subagents of the primary, each on its own OpenRouter model.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | The driver plugin (`@dsh-demo/driver`): creates the primary agent, starts the workflow via `ctx.workflowEngine.start(...)`, prints the result, exits 0/1. The workflow script (with per-agent `provider`/`model`/`schema`) is embedded as `SCRIPT`. |
| `package.json` | `link:` deps to the DSH monorepo packages (same cordis instance as the running CLI), `tsx` + `typescript` dev deps. |
| `tsconfig.json` | Typecheck config (`pnpm typecheck`). |
| `~/.dsh/profiles/dsh-demo/package.json` | Profile definition: bundles `@deepseek-ai/dsh-base` only (no headless runner, no web). |
| `~/.dsh/profiles/dsh-demo/cordis.patch.yml` | Mounts the driver plugin. |
| `~/.dsh/profiles/dsh-demo/node_modules/@dsh-demo/driver` | Symlink → this project, so the loader's bare specifier `@dsh-demo/driver` resolves. |
| `~/.dsh/settings.yaml` | `openai/gpt-5.6-luna` added to the `openrouter` provider's models. |

## How it works

- The CLI (`node .../apps/cli/lib/bin.js --profile dsh-demo`) boots a Cordis
  tree from the profile: `dsh-base` provides agents, sessions, llm-pi-ai
  (openrouter route), tools (fs/bash/subagent/workflow), and the workflow
  engine (`dsh-workflow-worker-thread`, provider `spawn`).
- The driver mounts as a plugin, awaits the loader, creates the primary agent
  with explicit `agentOptions: { provider: 'openrouter', model: '~deepseek/...' }`.
- `ctx.workflowEngine.start({ script, meta, args: { cwd }, parent: primaryAgent })`
  runs the plain-JS script in a worker-thread vm. Each `agent()` call spawns a
  subagent of the primary with per-call `provider`/`model` and an
  `outputSchema`; the host maps `schema` → `outputSchema` and
  `provider`/`model` → `agentOptions` on the subagent seam.
- Structured results come back through the child's `structured_output` tool
  (attached by the in-process driver), so the script gets a typed value like
  `{ number: 47 }` instead of free text.
- The script branches on parity deterministically, spawns B or C to compute
  and write the file (children inherit the fs tools + cwd from the parent),
  and returns `{ number, odd, branch, file, value }`.
- The driver hands the result to the primary agent for a confirmation turn,
  flushes the session, disposes the workflow run (terminates the worker
  thread), and requests `appExit(0/1)`.

## Realtime output & timeouts

The driver does **not** blindly wait for the final result:

- **Realtime progress** — `watchWorkflow()` subscribes to the live event
  firehose and prints, as it happens:
  - `[A] started` / `[A] completed|failed|cancelled` — agent lifecycle
    (`workflow/agent-start` / `workflow/agent-end`), prefixed with the
    agent's name (the script's `label` option: `A`, `B`, `C`)
  - `[wf] script: ...` — narration lines from the script's `log()` calls
    (`workflow/log`; `[wf]` = workflow-level, not agent-bound)
  - the **token stream** of every child agent as it is generated
    (`session/event` → `assistant/chunk` text deltas), streamed under the
    agent's prefix, plus `[A] → tool bash` lines each time a child calls a
    tool (`tool/call`) — so you see agent A run `bash`, then
    `structured_output`, live.
- **Timeout** — set `config.timeoutMs` (e.g. via the profile patch) and the
  run is given an `AbortSignal.timeout(...)`; on expiry the workflow and its
  children are cancelled and the driver exits `1` with a clear message instead
  of hanging. No timeout by default.

## Run it

```bash
cd /Users/tyler.liu/src/ai/dsh-demo
pnpm install
pnpm demo          # = node --import tsx <dsh>/apps/cli/lib/bin.js --profile dsh-demo
```

`tsx` is required because the driver is TypeScript and the loader has no TS
hook — `node --import tsx` installs the transform into Node's cascaded module
loader, which the DSH loader uses for its imports.

## Verified results

- Odd path: random number 45 → agent B computed `45 × 9 = 405` → `b.txt` = `405`
  (also 47→423, 57→513, 73→657 on earlier runs).
- Even path: random number 50 → agent C computed `50 × 10 = 500` → `c.txt` = `500`.
- The primary agent confirmed the written file on disk in every run.
- Process exits cleanly with code 0.

## Notes / gotchas found along the way

- `structured_output` is the child's structured-result tool; the prompt MUST
  explicitly demand calling it, or the model answers in plain text and the
  child is scored `error` (no captured value).
- LLMs are bad at "pick a random number" (a tiny biased set like {47,57,73}
  comes back). Agent A is therefore told to run
  `node -e "console.log(Math.floor(Math.random()*100)+1)"` via the bash tool —
  still the subagent generating the number, but genuinely random.
- The workflow worker thread keeps the process alive; `run.dispose()` must be
  awaited before `appExit` or the process hangs past the CLI's force-exit
  timer.
- `ctx.appExit` is a launcher-provided host value (read via `ctx.get`, never
  injected).