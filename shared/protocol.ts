/**
 * protocol.ts — the one shared WebSocket contract for harness-workflow.
 *
 * The run request shape, the run event union, the lane identity, and the WS
 * path constant live here, in a top-level module of their own, so that both
 * sides of the WebSocket import the same contract and it cannot drift: the
 * server (src/) sends and receives these shapes, and the React client (the
 * frontend source tree) types its WebSocket code against them.
 *
 * Domain vocabulary (parent ticket #1): a **run** is one submitted task; a
 * **lane** is one side of the comparison (a selected model + its worker +
 * its output panel); the **orchestrator** is the primary agent that spawns
 * the two lane workers. Identifiers use this run / lane / worker /
 * orchestrator vocabulary.
 */

/** Identifies which lane a worker belongs to. */
export type LaneId = "left" | "right";

/** The configuration for one comparison run. */
export interface RunRequest {
	/** The task text the user submitted. */
	task: string;
	/** The model the orchestrator (primary agent) runs on. */
	primaryModel: string;
	/** The model each lane worker runs on. */
	laneModels: Record<LaneId, string>;
	/**
	 * The persisted session to resume: the run continues that session, loading
	 * its saved context so the new turns append to the same session. The run's
	 * workspace is the resumed session's cwd from its header, not a request
	 * field. A session the harness cannot resume fails immediately: both lanes
	 * error and the run ends before any worker starts.
	 */
	sessionId: string;
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

/** WebSocket endpoint path, shared by the server and the client. */
export const WS_PATH = "/ws";
