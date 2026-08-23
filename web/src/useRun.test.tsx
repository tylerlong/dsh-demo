// @vitest-environment jsdom
/**
 * useRun.test.tsx — component tests for the run lifecycle hook (ticket #33).
 *
 * The hook owns the WebSocket connection and the run state machine (idle →
 * running → streaming events → done / error / canceled) plus input locking.
 * These tests drive the whole lifecycle with a mocked WebSocket injected
 * through App's createSocket seam, and assert only what a user sees — the
 * streamed lane output, the run and lane status chips, the locked/unlocked
 * inputs, and the submit/cancel enabled states — never internal component
 * state. This replaces the deleted server-side browser-script wiring suite:
 * the client behavior it pinned is now verified against the React DOM using
 * the shared protocol's event vocabulary (shared/protocol.ts).
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunRequest } from "../../shared/protocol.ts";
import { App } from "./App.tsx";
import type { ModelsResponse, WorkspaceOption } from "./api.ts";

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

const WORKSPACES: readonly WorkspaceOption[] = [
	{
		id: "ws-alpha",
		path: "/opt/alpha-project",
		title: "Alpha",
		newestSessionAt: 1700000000000,
	},
	{
		id: "ws-beta",
		path: "/opt/beta-project",
		title: "Beta",
		newestSessionAt: 1700000500000,
	},
];

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

/** Render the whole app with a scriptable socket and ready form data. */
function renderApp(): FakeWebSocket {
	const socket = new FakeWebSocket();
	render(
		<App
			createSocket={() => socket as unknown as WebSocket}
			loadModels={async () => MODELS}
			loadWorkspaces={async () => WORKSPACES}
		/>,
	);
	return socket;
}

/** The controls the tests drive, queried the way a user sees them. */
function controls() {
	return {
		task: screen.getByLabelText("Task"),
		primary: screen.getByRole("combobox", { name: "Primary model" }),
		workspace: screen.getByRole("combobox", { name: "Workspace" }),
		submit: screen.getByRole("button", { name: "Submit" }),
		cancel: screen.getByRole("button", { name: "Cancel" }),
		connStatus: screen.getByTestId("conn-status"),
		primaryStatus: screen.getByTestId("primary-status"),
		primaryOutput: screen.getByTestId("primary-output"),
		leftStatus: screen.getByTestId("lane-left-status"),
		leftOutput: screen.getByTestId("lane-left-output"),
		rightStatus: screen.getByTestId("lane-right-status"),
		rightOutput: screen.getByTestId("lane-right-output"),
	};
}

/** Wait until the form data has loaded and submit is usable. */
async function readyForm(): Promise<void> {
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled(),
	);
}

/**
 * The request the form assembles from the defaults and the typed task. The
 * request carries the session to resume (parent #37); the session browser
 * that supplies a real session id lands in ticket #41, so it is empty here.
 */
function expectedRequest(task: string): RunRequest {
	return {
		task,
		primaryModel: MODELS.defaults.primary,
		laneModels: {
			left: MODELS.defaults.left,
			right: MODELS.defaults.right,
		},
		sessionId: "",
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
	it("submit starts both lanes and streams their output live, locking the inputs", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);

		// The assembled run request goes over the socket in the shared shape.
		expect(lastSent(socket)).toEqual({
			type: "submit",
			request: expectedRequest("haiku"),
		});

		// run/started locks the inputs and arms cancel.
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		expect(controls().task).toBeDisabled();
		expect(controls().primary).toBeDisabled();
		expect(controls().workspace).toBeDisabled();
		expect(controls().submit).toBeDisabled();
		expect(controls().cancel).toBeEnabled();
		expect(controls().primaryStatus).toHaveTextContent(/^running/);

		// Both lanes start and stream their deltas live.
		act(() => socket.emit({ type: "lane/worker/started", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/started", laneId: "right" }));
		expect(controls().leftStatus).toHaveTextContent(/^running/);
		expect(controls().rightStatus).toHaveTextContent(/^running/);

		act(() =>
			socket.emit({ type: "lane/worker/delta", laneId: "left", text: "the " }),
		);
		act(() =>
			socket.emit({ type: "lane/worker/delta", laneId: "left", text: "sea" }),
		);
		act(() =>
			socket.emit({ type: "lane/worker/delta", laneId: "right", text: "the " }),
		);
		act(() =>
			socket.emit({
				type: "lane/worker/delta",
				laneId: "right",
				text: "shore",
			}),
		);
		act(() =>
			socket.emit({ type: "orchestrator/delta", text: "spawning workers" }),
		);
		expect(controls().leftOutput).toHaveTextContent("the sea");
		expect(controls().rightOutput).toHaveTextContent("the shore");
		expect(controls().primaryOutput).toHaveTextContent("spawning workers");

		// Both lanes settle, the run ends done, and the inputs unlock.
		act(() => socket.emit({ type: "lane/worker/done", laneId: "left" }));
		act(() => socket.emit({ type: "lane/worker/done", laneId: "right" }));
		act(() => socket.emit({ type: "run/done", runId: "run-1" }));
		expect(controls().leftStatus).toHaveTextContent(/^done/);
		expect(controls().rightStatus).toHaveTextContent(/^done/);
		expect(controls().primaryStatus).toHaveTextContent(/^done/);
		expect(controls().task).toBeEnabled();
		expect(controls().submit).toBeEnabled();
		expect(controls().cancel).toBeDisabled();
	});

	it("cancel aborts the whole run and a terminal run frees the form for a new run", async () => {
		const user = userEvent.setup();
		const socket = renderApp();
		await readyForm();
		act(() => socket.open());

		await user.type(controls().task, "haiku");
		await user.click(controls().submit);
		act(() => socket.emit({ type: "run/started", runId: "run-1" }));
		await user.click(controls().cancel);

		// Cancel goes over the socket; run/canceled ends the run and unlocks.
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
