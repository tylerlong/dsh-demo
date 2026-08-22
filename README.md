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
   ├─ deterministic branch on parity (driver logic, not an LLM decision)
   │
   ├─ odd  → starts agent B (~deepseek/deepseek-v4-flash-latest)
   │          computes n × 9  → writes b.txt in the project folder
   │
   └─ even → starts agent C (openai/gpt-5.6-luna)
              computes n × 10 → writes c.txt in the project folder
```

The primary agent then receives the result and confirms the written file, so
"primary agent gets the result from agent A" holds in the DSH sense: A/B/C are
all subagents of the primary, each on its own OpenRouter model.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | The driver plugin (`@dsh-demo/driver`): creates the primary agent, orchestrates A/B/C via direct `subagents.start('spawn', ...)` calls, prints the result, exits 0/1. No workflow script string — the driver IS the orchestrator. |
| `package.json` | `link:` deps to the DSH monorepo packages (same cordis instance as the running CLI), `tsx` + `typescript` dev deps. |
| `tsconfig.json` | Typecheck config (`pnpm typecheck`). |
| `~/.dsh/profiles/dsh-demo/package.json` | Profile definition: bundles `@deepseek-ai/dsh-base` only (no headless runner, no web). |
| `~/.dsh/profiles/dsh-demo/cordis.patch.yml` | Mounts the driver plugin. |
| `~/.dsh/profiles/dsh-demo/node_modules/@dsh-demo/driver` | Symlink → this project, so the loader's bare specifier `@dsh-demo/driver` resolves. |
| `~/.dsh/settings.yaml` | `openai/gpt-5.6-luna` added to the `openrouter` provider's models. |

## How it works

- The CLI (`node .../apps/cli/lib/bin.js --profile dsh-demo`) boots a Cordis
  tree from the profile: `dsh-base` provides agents, sessions, llm-pi-ai
  (openrouter route), tools (fs/bash/subagent), and the subagent service
  (`dsh-subagent` with the in-process `spawn` provider).
- The driver mounts as a plugin, awaits the loader, creates the primary agent
  with explicit `agentOptions: { provider: 'openrouter', model: '~deepseek/...' }`.
- Each child is a direct call to the subagent seam:
  `subagents.start('spawn', { label, prompt, parent, signal, agentOptions, outputSchema })`
  — the `spawn` provider is the same in-process driver the workflow engine
  used, but now called straight from TypeScript. No script string, no vm
  sandbox: the driver is the orchestrator, and `agent A`/`agent B`/`agent C`
  are ordinary subagent runs.
- Structured results come back through the child's `structured_output` tool
  (attached by the in-process driver when `outputSchema` is set), so the
  driver gets a typed value like `{ number: 47 }` instead of free text.
- The driver branches on parity deterministically, then spawns B or C to
  compute and write the file (children inherit the fs tools + cwd from the
  parent).
- The driver hands the result to the primary agent for a confirmation turn,
  flushes the session, disposes each child run (reaches child quiescence so
  the process can exit), and requests `appExit(0/1)`.

## Realtime output & timeouts

The driver does **not** blindly wait for the final result:

- **Realtime progress** — `watchChild()` subscribes to the live event
  firehose (`session/event`, filtered to each child's session) and prints, as
  it happens:
  - `[A] started` / `[A] completed` — child lifecycle, prefixed with the
    agent's name (`A`, `B`, `C`)
  - the **token stream** of every child agent as it is generated
    (`assistant/chunk` text deltas), streamed under the agent's prefix, plus
    `[A] → tool bash` lines each time a child calls a tool (`tool/call`) — so
    you see agent A run `bash`, then `structured_output`, live.
- **Timeout** — set `config.timeoutMs` (e.g. via the profile patch) and the
  run is given an `AbortSignal.timeout(...)` shared by both children; on
  expiry the active child is cancelled and the driver exits `1` with a clear
  message instead of hanging. No timeout by default.

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
- Even path: random number 50 → agent C computed `50 × 10 = 500` → `c.txt` = `500`
  (also 44→440 on the direct-orchestration run).
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
- Each child run must be `dispose()`d after settling, or the child keeps the
  process alive past the CLI's force-exit timer.
- `ctx.appExit` is a launcher-provided host value (read via `ctx.get`, never
  injected).