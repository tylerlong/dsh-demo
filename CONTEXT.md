# dsh-compare

A local web app that runs one submitted task on two AI models concurrently, in separate browser tabs, and streams both results live so they can be compared side by side.

## Language

**run**:
One submitted task together with the work of comparing it on the two selected models.
_Avoid_: job, try, comparison, submission

**lane**:
One side of the comparison: a model, the worker that performs the run's task on that model, and that worker's output.
_Avoid_: column, panel, side

**worker**:
A read-only sub-agent spawned to perform the run's task on its lane's model. Workers only read from the workspace so concurrent lanes never conflict over edits.
_Avoid_: task agent, sub-task, helper

**orchestrator**:
The primary agent for a run: it spawns and coordinates the two workers, waits for both, then produces a comparison summary.
_Avoid_: coordinator, manager, driver

**dsh-compare**:
The app's name. Use it when referring to the whole local web application rather than a single run.
