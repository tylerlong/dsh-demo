# harness-workflow

A local web app that runs one submitted task on two AI models concurrently so they can be compared side by side. A read-only session browser lists workspaces and their sessions from the shared DSH store; continuing a session resumes it rather than creating a new one.

The `examples/` archive holds pre-product DSH-harness experiments — frozen reference snippets, each with its own boot copy — not part of `harness-workflow`.

The product UI is a TypeScript + React single-page application (built with Vite, styled with Tailwind; see ADR-0005).

## Language

**run**:
One submitted task together with the work of comparing it on the two selected models.
_Avoid_: job, try, comparison, submission

**lane**:
One side of the comparison: a model, the worker that performs the run's task on that model, and that worker's output.
_Avoid_: column, panel, side

**session**:
A persisted conversation in the shared DSH store (owned by DSH web), labeled by its session id. Continuing a session resumes it rather than creating a new one: the primary agent inherits its saved context and the run's new turns append to the same session.
_Avoid_: thread, chat, dialog

**workspace**:
The folder a session runs in, derived from the resumed session's cwd (from its header) rather than chosen in the form. harness-workflow reads the shared DSH workspace catalog (owned by DSH web) read-only. It becomes the orchestrator's session cwd, and spawned workers inherit it. Considered read-only.
_Avoid_: project folder, working directory, cwd

**worker**:
A read-only sub-agent spawned to perform the run's task on its lane's model. Workers only read from the workspace so concurrent lanes never conflict over edits.
_Avoid_: task agent, sub-task, helper

**orchestrator**:
The primary agent for a run: it spawns and coordinates the two workers and waits for both to settle. It does not produce a comparison summary.
_Avoid_: coordinator, manager, driver

**harness-workflow**:
The app's name. Use it when referring to the whole local web application rather than a single run.
