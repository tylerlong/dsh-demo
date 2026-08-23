/**
 * run-factory.ts — the single run-factory seam for harness-workflow.
 *
 * The server (ticket #3) depends on this injected run factory to start a
 * comparison run and receive its live events. Production wires the seam to
 * harness-backed orchestration (ticket #5); tests inject the scripted fake
 * factory in this module to drive behavior without any real LLM calls.
 *
 * The WebSocket contract itself (the run request shape, the run event
 * union, the lane identity) lives in the shared protocol module
 * (shared/protocol.ts, ticket #30) and is re-exported here so this module
 * stays the single run-factory seam.
 *
 * The scripted fake factory here mirrors the run final contract: a run
 * carries a **sessionId** (the session to resume, parent ticket #37), ends
 * with run/done as soon as both lanes settle (each done or errored), and
 * never emits run/summary.
 */
import type { LaneId, RunEvent, RunRequest } from "../shared/protocol.ts";

/** Identifies which lane a worker belongs to (shared WebSocket contract). */
export type { LaneId } from "../shared/protocol.ts";

/** One worker lifecycle status, shown as a status chip per lane. */
export type LaneStatus = "running" | "done" | "error";

/** The run request shape and event union (shared WebSocket contract). */
export type { RunEvent, RunRequest } from "../shared/protocol.ts";

/** Opaque handle to a started run; lives for the run whole lifetime. */
export interface RunHandle {
	/** Stable id for this run. */
	readonly id: string;
	/** Abort the whole run (orchestrator and both workers). */
	cancel(): void;
}

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

/**
 * Build a scripted fake run factory.
 *
 * Each startRun call:
 *   1. records the request and the given onEvent sink,
 *   2. produces a run handle (stable incremental id; cancel marks it canceled),
 *   3. emits the run initial run/started event,
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
