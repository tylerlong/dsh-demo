/**
 * useRun.ts — the run lifecycle hook (ticket #33).
 *
 * Owns the WebSocket connection and the run state machine — idle → running
 * (streaming events) → done / error / canceled — plus input locking. The hook
 * opens the socket to the shared WS_PATH on mount, submits a run request and
 * cancels the active run over it, and routes every run event from the shared
 * protocol (shared/protocol.ts) into state the UI renders: the run status,
 * the orchestrator's top output, and each lane's status chip and streamed
 * output. It exposes `locked` so the run configuration form disables its
 * inputs while a run is active.
 *
 * The connection status is its own four-state machine — connecting /
 * connected / disconnected / error — so the user always knows whether the
 * server link is up. A connection failure while a run is active ends the run
 * in the error state: the server aborts the run when the socket drops, but
 * the client cannot receive the run/canceled event over the dead socket, so
 * the hook settles the run itself.
 *
 * The socket is created through an injectable seam (`createSocket`) so the
 * component tests drive the whole lifecycle with a mocked WebSocket; the
 * default opens a real socket to the current origin's shared WS_PATH.
 */
import { useEffect, useRef, useState } from "react";
import type { LaneId, RunEvent, RunRequest } from "../../shared/protocol.ts";
import { WS_PATH } from "../../shared/protocol.ts";

/** The four-state connection status shown in the header. */
export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

/** The run state machine: idle → running → done / error / canceled. */
export type RunState = "idle" | "running" | "done" | "error" | "canceled";

/** One lane worker's lifecycle status, shown as a status chip. */
export type LaneStatus = "idle" | "running" | "done" | "error" | "canceled";

/** The per-lane state the hook owns: status chip, streamed output, elapsed. */
export interface LaneRunState {
	readonly status: LaneStatus;
	/** The lane worker's streamed text, appended live from deltas. */
	readonly output: string;
	/** Seconds since the lane worker started (frozen at its terminal state). */
	readonly elapsed: number;
}

/** Options for {@link useRun}. */
export interface UseRunOptions {
	/**
	 * Create the WebSocket the hook drives. Defaults to a real socket to the
	 * shared WS_PATH on the current origin; tests inject a fake so the whole
	 * lifecycle is scriptable without a browser.
	 */
	readonly createSocket?: () => WebSocket;
}

/** The run lifecycle surface the app shell renders against. */
export interface UseRunResult {
	/** The connection status, shown in the header. */
	readonly connectionStatus: ConnectionStatus;
	/** The run state machine's current state. */
	readonly runState: RunState;
	/** The active run's id, once run/started has arrived. */
	readonly runId: string | undefined;
	/** Seconds since the run started (frozen at its terminal state). */
	readonly runElapsed: number;
	/** Per-lane status chip, streamed output, and elapsed seconds. */
	readonly lanes: Record<LaneId, LaneRunState>;
	/** The orchestrator's streamed output (the run's top section). */
	readonly orchestratorOutput: string;
	/** Whether a run is active: locks the form inputs and arms Cancel. */
	readonly locked: boolean;
	/**
	 * Submit a run request over the socket (no-op unless connected and no run
	 * is active; a terminal run frees the form for a new one).
	 */
	readonly submit: (request: RunRequest) => void;
	/** Cancel the active run over the socket (no-op unless a run is running). */
	readonly cancel: () => void;
}

/** A fresh idle lane: no chip, no output, no elapsed time. */
function idleLane(): LaneRunState {
	return { status: "idle", output: "", elapsed: 0 };
}

/** The default socket: the shared WS path on the current origin. */
function defaultCreateSocket(): WebSocket {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocket(`${protocol}//${location.host}${WS_PATH}`);
}

/** Wind every lane still running down to a terminal status. */
function settleRunningLanes(
	lanes: Record<LaneId, LaneRunState>,
	status: LaneStatus,
): Record<LaneId, LaneRunState> {
	const settle = (lane: LaneRunState): LaneRunState =>
		lane.status === "running" ? { ...lane, status } : lane;
	return { left: settle(lanes.left), right: settle(lanes.right) };
}

export function useRun({ createSocket }: UseRunOptions = {}): UseRunResult {
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [runState, setRunState] = useState<RunState>("idle");
	const [runId, setRunId] = useState<string | undefined>(undefined);
	const [runElapsed, setRunElapsed] = useState(0);
	const [lanes, setLanes] = useState<Record<LaneId, LaneRunState>>({
		left: idleLane(),
		right: idleLane(),
	});
	const [orchestratorOutput, setOrchestratorOutput] = useState("");

	// The socket and the run state live behind refs so the mount-time socket
	// handlers and the submit/cancel actions always read the current run state
	// without re-registering the socket on every render.
	const createSocketRef = useRef(createSocket);
	const wsRef = useRef<WebSocket | null>(null);
	const runStateRef = useRef<RunState>("idle");
	useEffect(() => {
		runStateRef.current = runState;
	}, [runState]);

	// Open the socket once on mount (the seam is captured at first render).
	useEffect(() => {
		const ws = (createSocketRef.current ?? defaultCreateSocket)();
		wsRef.current = ws;

		/** Route one run event from the shared protocol into hook state. */
		const handleEvent = (event: RunEvent): void => {
			switch (event.type) {
				case "run/started":
					setRunId(event.runId);
					setRunState("running");
					setRunElapsed(0);
					setOrchestratorOutput("");
					setLanes({ left: idleLane(), right: idleLane() });
					break;
				case "run/done":
					// A clear completion signal: any lane still running is done.
					setLanes((previous) => settleRunningLanes(previous, "done"));
					setRunState("done");
					break;
				case "run/canceled":
					// The whole run aborted: running lanes wind down to canceled.
					setLanes((previous) => settleRunningLanes(previous, "canceled"));
					setRunState("canceled");
					break;
				case "orchestrator/delta":
					setOrchestratorOutput((previous) => previous + event.text);
					break;
				case "lane/worker/started":
					setLanes((previous) => ({
						...previous,
						[event.laneId]: {
							...previous[event.laneId],
							status: "running",
							elapsed: 0,
						},
					}));
					break;
				case "lane/worker/delta":
					setLanes((previous) => ({
						...previous,
						[event.laneId]: {
							...previous[event.laneId],
							output: previous[event.laneId].output + event.text,
						},
					}));
					break;
				case "lane/worker/done":
					setLanes((previous) => ({
						...previous,
						[event.laneId]: { ...previous[event.laneId], status: "done" },
					}));
					break;
				case "lane/worker/error":
					setLanes((previous) => ({
						...previous,
						[event.laneId]: { ...previous[event.laneId], status: "error" },
					}));
					break;
			}
		};

		ws.onopen = () => {
			setConnectionStatus("connected");
		};
		ws.onerror = () => {
			setConnectionStatus("error");
			// A connection failure while a run is active ends the run in the
			// error state: the server aborts the run on disconnect, but the
			// client cannot receive run/canceled over the dead socket.
			if (runStateRef.current === "running") {
				setLanes((previous) => settleRunningLanes(previous, "error"));
				setRunState("error");
			}
		};
		ws.onclose = () => {
			setConnectionStatus("disconnected");
			if (runStateRef.current === "running") {
				setLanes((previous) => settleRunningLanes(previous, "error"));
				setRunState("error");
			}
		};
		ws.onmessage = (message) => {
			try {
				handleEvent(JSON.parse(String(message.data)) as RunEvent);
			} catch {
				// Ignore malformed frames, exactly as the vanilla script did.
			}
		};

		return () => {
			wsRef.current = null;
			ws.close();
		};
	}, []);

	// The run-level elapsed timer runs only while a run is active.
	useEffect(() => {
		if (runState !== "running") {
			return;
		}
		const timer = setInterval(() => {
			setRunElapsed((seconds) => seconds + 1);
		}, 1000);
		return () => clearInterval(timer);
	}, [runState]);

	// Each lane's elapsed timer runs only while that lane worker is running.
	useEffect(() => {
		if (lanes.left.status !== "running") {
			return;
		}
		const timer = setInterval(() => {
			setLanes((previous) => ({
				...previous,
				left: { ...previous.left, elapsed: previous.left.elapsed + 1 },
			}));
		}, 1000);
		return () => clearInterval(timer);
	}, [lanes.left.status]);
	useEffect(() => {
		if (lanes.right.status !== "running") {
			return;
		}
		const timer = setInterval(() => {
			setLanes((previous) => ({
				...previous,
				right: { ...previous.right, elapsed: previous.right.elapsed + 1 },
			}));
		}, 1000);
		return () => clearInterval(timer);
	}, [lanes.right.status]);

	/**
	 * Submit a run request; ignored unless connected and no run is active.
	 * A terminal run (done / error / canceled) frees the form for a new one.
	 */
	const submit = (request: RunRequest): void => {
		const ws = wsRef.current;
		if (ws === null || ws.readyState !== WebSocket.OPEN) {
			return;
		}
		if (runStateRef.current === "running") {
			return;
		}
		ws.send(JSON.stringify({ type: "submit", request }));
	};

	/** Cancel the active run; ignored unless a run is running. */
	const cancel = (): void => {
		const ws = wsRef.current;
		if (ws === null || ws.readyState !== WebSocket.OPEN) {
			return;
		}
		if (runStateRef.current !== "running") {
			return;
		}
		ws.send(JSON.stringify({ type: "cancel" }));
	};

	return {
		connectionStatus,
		runState,
		runId,
		runElapsed,
		lanes,
		orchestratorOutput,
		locked: runState === "running",
		submit,
		cancel,
	};
}
