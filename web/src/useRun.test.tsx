// @vitest-environment jsdom
/**
 * useRun.test.tsx — component tests for the run lifecycle hook (ticket #33,
 * parent #37).
 *
 * The hook owns the WebSocket connection and the run state machine (idle →
 * running → done / error / canceled) plus input locking. These tests drive
 * the whole lifecycle with a mocked WebSocket injected through App's
 * createSocket seam, and assert only what a user sees — the run and lane
 * status chips, the locked/unlocked inputs, and the submit/cancel enabled
 * states — never internal component state. The session browser (parent #37)
 * is present but scripted: the tree loads, the latest session is preselected
 * (arming submit), and a watch message registers the viewed session. Rendered
 * output is NOT asserted here — it comes from the store via the transcript
 * panel, covered by SessionBrowser.test.tsx.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunRequest } from "../../shared/protocol.ts";
import { App } from "./App.tsx";
import type { ModelsResponse, SessionTranscript, SessionTree } from "./api.ts";

const MODELS: ModelsResponse = {
	models: [
		{
			provider: "openrouter",
			id: "deepseek/deepseek-v4-flash-0731",
			name: "DeepSeek V4 Flash 0731",
		},
		{
			provider: "openrouter",
			id: "openai/gpt-5.6-luna",
			name: "GPT 5.6 Luna",
		},
	],
	defaults: {
		primary: "deepseek/deepseek-v4-flash-0731",
		left: "deepseek/deepseek-v4-flash-0731",
		right: "openai/gpt-5.6-luna",
	},
};

const SESSION_TREE: SessionTree = [
	{
		id: "ws-alpha",
		path: "/opt/alpha-project",
		title: "Alpha",
		sessions: [
			{
				id: "session-1",
				label: "Refactor the seam",
				updatedAt: 1700000000000,
			},
			{
				id: "session-2",
				label: "Wire the run",
				updatedAt: 1700000500000,
			},
		],
	},
];

const TRANSCRIPT: SessionTranscript = {
	primary: {
		sessionId: "session-2",
		lines: [{ text: "primary output", role: "output" }],
	},
	lanes: [],
	moreBefore: false,
};

/**
 * A scriptable WebSocket fake: the test opens/closes/errors it and emits run
 * events exactly as the server serializes them, while recording every send.
 */
class FakeWebSocket {
	readyState = 0; // CONNECTING
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((message: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;

	/** Simulate the server accepting the connection. */
	open(): void {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}
	/** Simulate a network error on the socket (the close event follows). */
	error(): void {
		this.readyState = 3; // CLOSED
		this.onerror?.();
	}
	/** Simulate the socket closing. */
	close(): void {
		this.readyState = 3; // CLOSED
		this.onclose?.();
	}
	send(data: string): void {
		this.sent.push(data);
	}
	/** Deliver one run event, exactly as the server serializes it. */
	emit(event: RunEvent): void {
		this.onmessage?.({ data: JSON.stringify(event) });
	}
}

/** Render the whole app with a scriptable socket and ready session data. */
function renderApp(): FakeWebSocket {
	const socket = new FakeWebSocket();
	render(
		<App
			createSocket={() => socket as unknown as WebSocket}
			loadModels={async () => MODELS}
			loadSessions={async () => SESSION_TREE}
			loadTranscript={async () => TRANSCRIPT}
		/>,
	);
	return socket;
}

/** The controls the tests drive, queried the way a user sees them. */
function controls() {
	return {
		task: screen.getByLabelText("Task"),
		primary: screen.getByRole("combobox", { name: "Primary model" }),
		submit: screen.getByRole("button", { name: "Submit" }),
		cancel: screen.getByRole("button", { name: "Cancel" }),
		connStatus: screen.getByTestId("conn-status"),
		primaryStatus: screen.getByTestId("primary-status"),
		leftStatus: screen.getByTestId("lane-left-status"),
		rightStatus: screen.getByTestId("lane-right-status"),
	};
}

/**
 * Wait until the session tree has loaded, the latest session is preselected,
 * and the form data has loaded — i.e. submit is usable.
 */
async function readyForm(): Promise<void> {
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled(),
	);
}

/** The request the form assembles from the defaults and the typed task. */
function expectedRequest(task: string): RunRequest {
	return {
		task,
		primaryModel: MODELS.defaults.primary,
		laneModels: {
			left: MODELS.defaults.left,
			right: MODELS.defaults.right,
		},
		sessionId: "session-2",
	};
}

/** The last message the fake socket was asked to send. */
function lastSent(socket: FakeWebSocket): {
	type: string;
	request?: RunRequest;
} {
	const raw = socket.sent.at(-1);
	if (raw === undefined) {
		throw new Error("expected the socket to have sent a message");
	}
	return JSON.parse(raw) as { type: string; request?: RunRequest };
}

describe("useRun connection status", () => {
	it("shows connecting before the socket opens, then connected", async () => {
		const socket = renderApp();
		await readyForm();
		expect(controls().connStatus).toHaveTextContent("connecting");

		act(() => socket.open());
		expect(controls().connStatus).toHaveTextContent("connected");
	});

	it("shows error on a socket error and disconnected on close", async () => {
		const socket = renderApp();
		await readyForm();

		act(() => socket.open());
		act(() => socket.error());
		expect(controls().connStatus).toHaveTextContent("error");

		act(() => socket.close());
		expect(controls().connStatus).toHaveTextContent("disconnected");
	});
});

describe("useRun run lifecycle", () => {
	it("watches the preselected session and submits a run carrying its session id, locking the inputs", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		// The preselected session's watch is (re)sent once the socket opens.
		expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
			type: "watch",
			sessionId: "session-2",
		});

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);

		// The assembled run request goes over the socket in the shared shape,
		// carrying the selected session id (parent #37).
		expect(lastSent(socket)).toEqual({
			type: "submit",
			request: expectedRequest("haiku"),
		});

		// run/started locks the inputs and arms cancel.
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		expect(controls().task).toBeDisabled();
		expect(controls().primary).toBeDisabled();
		expect(controls().submit).toBeDisabled();
		expect(controls().cancel).toBeEnabled();
		expect(controls().primaryStatus).toHaveTextContent(/^running/);

		// Both lanes start and settle; the status chips follow the events.
		act(() => socket.emit({ type: "lane/worker/started", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "right" }));
		expect(controls().leftStatus).toHaveTextContent(/^running/);
		expect(controls().rightStatus).toHaveTextContent(/^running/);

		// The live lane answers stream over the socket and render in the
		// transcript panel (the store read of the child session shows only the
		// injected workspace context, never the answer).
		act(() =>
			socket.emit({
				type: "lane/worker/delta",
				laneId: "left",
				text: "left answer",
			}),
		);
		act(() =>
			socket.emit({
				type: "lane/worker/delta",
				laneId: "right",
				text: "right answer",
			}),
		);
		const streamed = screen.getAllByTestId("transcript-worker");
		expect(streamed).toHaveLength(2);
		expect(streamed[0]?.textContent ?? "").toContain("left answer");
		expect(streamed[1]?.textContent ?? "").toContain("right answer");

		act(() => socket.emit({ type: "lane/worker/done", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/done", laneId: "right" }));
		act(() => socket.emit({ type: "run/done", runId: "run-1" }));

		// The answers stay visible after the run ends.
		const after = screen.getAllByTestId("transcript-worker");
		expect(after).toHaveLength(2);
		expect(after[0]?.textContent ?? "").toContain("left answer");

		expect(controls().leftStatus).toHaveTextContent(/^done/);
		expect(controls().rightStatus).toHaveTextContent(/^done/);
		expect(controls().primaryStatus).toHaveTextContent(/^done/);
		// A terminal run unlocks the form for a new one.
		expect(controls().task).toBeEnabled();
		expect(controls().submit).toBeEnabled();
		expect(controls().cancel).toBeDisabled();
	});

	it("a new submit clears the previous run's streamed answers before run/started arrives", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		// First run streams answers and completes.
		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		act(() =>
			socket.emit({
				type: "lane/worker/delta",
				laneId: "left",
				text: "old answer",
			}),
		);
		act(() => socket.emit({ type: "lane/worker/done", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/done", laneId: "right" }));
		act(() => socket.emit({ type: "run/done", runId: "run-1" }));
		expect(screen.getAllByTestId("transcript-worker")).toHaveLength(1);

		// A new run is submitted; the old answers must not render in the gap
		// before run/started (they belong to the finished run).
		await user.clear(controls().task);
		await user.type(controls().task, "haiku two");
		await user.click(controls().submit);
		expect(screen.queryAllByTestId("transcript-worker")).toHaveLength(0);
	});

	it("cancel aborts the active run over the socket and a terminal run frees the form", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));

		await user.click(controls().cancel);
		expect(lastSent(socket)).toEqual({ type: "cancel" });

		act(() => socket.emit({ type: "run/canceled", runId: "run-1" }));
		expect(controls().primaryStatus).toHaveTextContent(/^canceled/);
		expect(controls().task).toBeEnabled();
		expect(controls().submit).toBeEnabled();

		// A new run can start once the previous one reached a terminal state.
		await user.clear(controls().task);
		await user.type(controls().task, "haiku two");
		await user.click(controls().submit);
		expect(lastSent(socket)).toEqual({
			type: "submit",
			request: expectedRequest("haiku two"),
		});
	});

	it("a lane error shows an error chip while the run still ends done", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "right" }));

		act(() =>
			socket.emit({
				type: "lane/worker/error",
				laneId: "left",
				reason: "rate limited",
			}),
		);
		act(() => socket.emit({ type: "lane/worker/done", laneId: "right" }));
		act(() => socket.emit({ type: "run/done", runId: "run-1" }));

		expect(controls().leftStatus).toHaveTextContent(/^error/);
		expect(controls().rightStatus).toHaveTextContent(/^done/);
		expect(controls().primaryStatus).toHaveTextContent(/^done/);
		expect(controls().task).toBeEnabled();
	});

	it("a connection failure mid-run ends the run in error and unlocks the inputs", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "right" }));

		act(() => socket.error());
		expect(controls().connStatus).toHaveTextContent("error");
		expect(controls().primaryStatus).toHaveTextContent(/^error/);
		expect(controls().leftStatus).toHaveTextContent(/^error/);
		expect(controls().rightStatus).toHaveTextContent(/^error/);
		expect(controls().task).toBeEnabled();
		expect(controls().submit).toBeEnabled();
	});

	it("ignores a submit while the socket is not connected", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		// The socket never opens: submit stays enabled (the form does not know
		// the connection state) but nothing is sent over the socket.
		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		expect(socket.sent).toEqual([]);
	});
});
