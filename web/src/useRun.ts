/**
 * useRun.ts — the run lifecycle hook (ticket #33).
 *
 * Owns the WebSocket connection and the run state machine — idle → running
 * (streaming events) → done / error / canceled — plus input locking. The hook
 * opens the socket to the shared WS_PATH on mount, submits a run request and
 * cancels the active run over it, and routes every run event from the shared
 * protocol (shared/protocol.ts) into state the UI renders: the run status and
 * each lane's status chip. It exposes `locked` so the run configuration form
 * disables its inputs while a run is active. Rendered output is NOT streamed
 * here — the session browser reads it from the store (parent ticket #37);
 * session/updated events are surfaced through `onSessionUpdated` so the
 * caller re-reads the viewed session's transcript.
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

/** The per-lane state the hook owns: status chip and elapsed. */
export interface LaneRunState {
	readonly status: LaneStatus;
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
	/**
	 * Called when the server pushes a session/updated event (parent ticket
	 * #37): the viewed session's store content advanced, so the caller should
	 * re-read its transcript. The callback is captured at first render, so it
	 * reads the current selection through a ref.
	 */
	readonly onSessionUpdated?: (sessionId: string) => void;
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
	/** Per-lane status chip and elapsed seconds. */
	readonly lanes: Record<LaneId, LaneRunState>;
	/**
	 * The live lane-worker answer text streamed over the socket
	 * (lane/worker/delta), kept after the run ends so the answers stay
	 * visible. Empty until a run streams deltas.
	 */
	readonly laneTexts: Record<LaneId, string>;
	/** Whether a run is active: locks the form inputs and arms Cancel. */
	readonly locked: boolean;
	/**
	 * Submit a run request over the socket; returns whether the request was
	 * actually sent (false when not connected or a run is active; a terminal
	 * run frees the form for a new one). The caller records the run only when
	 * it really begins.
	 */
	readonly submit: (request: RunRequest) => boolean;
	/** Cancel the active run over the socket (no-op unless a run is running). */
	readonly cancel: () => void;
	/**
	 * Tell the server which session this tab is viewing, so it pushes
	 * session/updated events while that session runs (no-op unless connected;
	 * re-sent when the socket opens).
	 */
	readonly watch: (sessionId: string) => void;
}

/** A fresh idle lane: no chip, no elapsed time. */
function idleLane(): LaneRunState {
	return { status: "idle", elapsed: 0 };
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

export function useRun({
	createSocket,
	onSessionUpdated,
}: UseRunOptions = {}): UseRunResult {
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [runState, setRunState] = useState<RunState>("idle");
	const [runId, setRunId] = useState<string | undefined>(undefined);
	const [runElapsed, setRunElapsed] = useState(0);
	const [lanes, setLanes] = useState<Record<LaneId, LaneRunState>>({
		left: idleLane(),
		right: idleLane(),
	});
	const [laneTexts, setLaneTexts] = useState<Record<LaneId, string>>({
		left: "",
		right: "",
	});

	// The socket and the run state live behind refs so the mount-time socket
	// handlers and the submit/cancel actions always read the current run state
	// without re-registering the socket on every render.
	const createSocketRef = useRef(createSocket);
	const onSessionUpdatedRef = useRef(onSessionUpdated);
	const wsRef = useRef<WebSocket | null>(null);
	const runStateRef = useRef<RunState>("idle");
	const watchSessionIdRef = useRef<string | undefined>(undefined);
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
					setLanes({ left: idleLane(), right: idleLane() });
					setLaneTexts({ left: "", right: "" });
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
					// The live lane-worker answer streams here; accumulate it so
					// the transcript panel renders it live and keeps it after
					// the run ends (the store read of the child session shows
					// only the injected workspace context, not the answer).
					setLaneTexts((previous) => ({
						...previous,
						[event.laneId]: previous[event.laneId] + event.text,
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
				case "session/updated":
					// The viewed session's store content advanced; the caller
					// re-reads its transcript (output comes from the store, never
					// assembled from streamed deltas — parent ticket #37).
					onSessionUpdatedRef.current?.(event.sessionId);
					break;
			}
		};

		ws.onopen = () => {
			setConnectionStatus("connected");
			// A watch requested before the socket opened is re-sent now, so live
			// updates resume after a reconnect or a slow initial connection.
			const pending = watchSessionIdRef.current;
			if (pending !== undefined) {
				ws.send(JSON.stringify({ type: "watch", sessionId: pending }));
			}
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
	const submit = (request: RunRequest): boolean => {
		const ws = wsRef.current;
		if (ws === null || ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		if (runStateRef.current === "running") {
			return false;
		}
		ws.send(JSON.stringify({ type: "submit", request }));
		return true;
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

	/**
	 * Tell the server which session this tab is viewing. The id is kept in a
	 * ref and re-sent whenever the socket opens, so live session/updated
	 * pushes resume after a reconnect (parent ticket #37).
	 */
	const watch = (sessionId: string): void => {
		watchSessionIdRef.current = sessionId;
		const ws = wsRef.current;
		if (ws === null || ws.readyState !== WebSocket.OPEN) {
			return;
		}
		ws.send(JSON.stringify({ type: "watch", sessionId }));
	};

	return {
		connectionStatus,
		runState,
		runId,
		runElapsed,
		lanes,
		laneTexts,
		locked: runState === "running",
		submit,
		cancel,
		watch,
	};
}
