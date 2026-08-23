/**
 * run-factory.ts — the single run-factory seam for harness-workflow.
 *
 * The server (ticket #3) depends on this injected run factory to start a
 * comparison run and receive its live events. Production wires the seam to
 * harness-backed orchestration (ticket #5); tests inject the scripted fake
 * factory in this module to drive behavior without any real LLM calls.
 *
 * Domain vocabulary (parent ticket #1): a **run** is one submitted task; a
 * **lane** is one side of the comparison (a selected model + its worker +
 * its output panel); the **orchestrator** is the primary agent that spawns
 * the two lane workers. Identifiers use this run / lane / worker /
 * orchestrator vocabulary.
 *
 * The scripted fake factory here mirrors the run final contract: a run
 * carries a **workspace** (the folder its agents may read), ends with
 * run/done as soon as both lanes settle (each done or errored), never
 * emits run/summary, and rejects a run whose workspace is not a valid folder
 * with both lanes erroring and run/done.
 */
import { statSync } from "node:fs";

/** Identifies which lane a worker belongs to. */
export type LaneId = "left" | "right";

/** One worker lifecycle status, shown as a status chip per lane. */
export type LaneStatus = "running" | "done" | "error";

/** The configuration for one comparison run. */
export interface RunRequest {
	/** The task text the user submitted. */
	task: string;
	/** The model the orchestrator (primary agent) runs on. */
	primaryModel: string;
	/** The model each lane worker runs on. */
	laneModels: Record<LaneId, string>;
	/**
	 * The workspace folder the run agents (orchestrator and both workers) may
	 * read for context. A run whose workspace is not a valid folder fails
	 * immediately: both lanes error and the run ends before any worker starts.
	 */
	workspace: string;
}

/** Opaque handle to a started run; lives for the run whole lifetime. */
export interface RunHandle {
	/** Stable id for this run. */
	readonly id: string;
	/** Abort the whole run (orchestrator and both workers). */
	cancel(): void;
}

/** The run has been created and its event stream has begun. */
export interface RunStartedEvent {
	type: "run/started";
	runId: string;
}

/** A text delta for the top section (orchestrator spawn notices / output). */
export interface OrchestratorDeltaEvent {
	type: "orchestrator/delta";
	text: string;
}

/** A lane worker has begun working. */
export interface LaneWorkerStartedEvent {
	type: "lane/worker/started";
	laneId: LaneId;
}

/** A text delta from one lane worker. */
export interface LaneWorkerDeltaEvent {
	type: "lane/worker/delta";
	laneId: LaneId;
	text: string;
}

/** One lane worker has completed its answer. */
export interface LaneWorkerDoneEvent {
	type: "lane/worker/done";
	laneId: LaneId;
}

/** One lane worker failed (bad model, rate limit, provider). */
export interface LaneWorkerErrorEvent {
	type: "lane/worker/error";
	laneId: LaneId;
	/**
	 * Error reason; logged to the server console only, never sent to the UI
	 * (the lane just shows an error status chip).
	 */
	reason: string;
}

/** The whole run completed successfully. */
export interface RunDoneEvent {
	type: "run/done";
	runId: string;
}

/** The run was aborted (Cancel, or disconnect). */
export interface RunCanceledEvent {
	type: "run/canceled";
	runId: string;
}

/**
 * The run event/message vocabulary, delivered through its onEvent sink.
 *
 * Lane events carry a laneId so the server can route each to the owning lane
 * panel; orchestrator events target the top section; run lifecycle events
 * describe the whole run. There is no run/summary: the run ends with run/done
 * as soon as both lanes settle. This is the contract the browser UI builds on.
 */
export type RunEvent =
	| RunStartedEvent
	| OrchestratorDeltaEvent
	| LaneWorkerStartedEvent
	| LaneWorkerDeltaEvent
	| LaneWorkerDoneEvent
	| LaneWorkerErrorEvent
	| RunDoneEvent
	| RunCanceledEvent;

/** The callback passed to the run to receive its live events. */
export type RunEventListener = (event: RunEvent) => void;

/**
 * The run factory seam: the server only dependency on orchestration.
 * A single injected function, so production hands it the harness-backed
 * entry and tests hand it a scripted fake.
 */
export type StartRun = (
	request: RunRequest,
	onEvent: RunEventListener,
) => RunHandle;

/** A run started by the scripted fake factory, with test control over it. */
export interface ScriptedRun {
	/** The request this run was started with. */
	readonly request: RunRequest;
	/** The handle the factory produced. */
	readonly handle: RunHandle;
	/** Whether cancel() was invoked on the handle. */
	readonly canceled: boolean;
	/**
	 * Deliver a scripted event through the run onEvent sink, exactly as the
	 * production factory would emit it. Tests call this to simulate the run
	 * streaming output, failing, or completing.
	 */
	emit(event: RunEvent): void;
}

/** A fake run factory the test suite injects in place of StartRun. */
export interface ScriptedRunFactory {
	/**
	 * The seam, callable exactly like a StartRun. Records the request and
	 * produces the run; a running ScriptedRun is available via runs/lastRun.
	 */
	readonly startRun: StartRun;
	/** Every run started, in start order. */
	readonly runs: readonly ScriptedRun[];
	/** The most recently started run, or undefined before the first call. */
	readonly lastRun: ScriptedRun | undefined;
}

/** Whether a path is an existing folder (the workspace must be one). */
function isValidWorkspaceFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Build a scripted fake run factory.
 *
 * Each startRun call:
 *   1. records the request and the given onEvent sink,
 *   2. produces a run handle (stable incremental id; cancel marks it canceled),
 *   3. emits the run initial run/started event; a run whose workspace is not
 *      a valid folder then fails immediately: both lanes error and the run
 *      ends (run/done) before any worker starts.
 *   4. re-emits lane events and, once both lanes settle (each done or
 *      errored), emits a single run/done. run/summary is never emitted.
 *
 * Tests inject the factory where the server expects a StartRun, then drive
 * the returned runs emit() and handle.cancel() to script behavior.
 */
export function createScriptedRunFactory(): ScriptedRunFactory {
	const runs: ScriptedRun[] = [];
	let nextId = 0;
	const startRun: StartRun = (request, onEvent) => {
		const id = String(nextId);
		nextId += 1;
		let canceled = false;
		const settled: Record<LaneId, boolean> = { left: false, right: false };
		let doneEmitted = false;
		/** Forward one event; once both lanes settle, follow with run/done. */
		const emit = (event: RunEvent): void => {
			onEvent(event);
			if (
				event.type === "lane/worker/done" ||
				event.type === "lane/worker/error"
			) {
				settled[event.laneId] = true;
			}
			if (settled.left && settled.right && !doneEmitted) {
				doneEmitted = true;
				onEvent({ type: "run/done", runId: id });
			}
		};
		const run: ScriptedRun = {
			request,
			handle: {
				id,
				cancel() {
					canceled = true;
				},
			},
			get canceled() {
				return canceled;
			},
			emit,
		};
		runs.push(run);
		emit({ type: "run/started", runId: id });
		if (!isValidWorkspaceFolder(request.workspace)) {
			// Reject the run before any worker starts: both lanes error, then
			// the auto-settle logic above emits run/done.
			emit({
				type: "lane/worker/error",
				laneId: "left",
				reason: `invalid workspace: ${request.workspace}`,
			});
			emit({
				type: "lane/worker/error",
				laneId: "right",
				reason: `invalid workspace: ${request.workspace}`,
			});
		}
		return run.handle;
	};
	return {
		startRun,
		runs,
		get lastRun() {
			return runs.at(-1);
		},
	};
}
