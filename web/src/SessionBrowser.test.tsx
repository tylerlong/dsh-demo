// @vitest-environment jsdom
/**
 * SessionBrowser.test.tsx — component tests for the session browser (parent
 * ticket #37, child ticket #41).
 *
 * The page is two regions: a left read-only workspace → sessions tree from
 * /api/sessions (loaded once on page load, no auto-reload, no "Ungrouped"
 * group, latest session preselected, selected row highlighted) and a right
 * region with the selected session's transcript (recent window read from the
 * store — never assembled from streamed deltas) plus the run form (workspace
 * dropdown removed, submit disabled until a session is selected, task field
 * empty). Live updates for the viewed running session are pushed over the
 * WebSocket as session/updated events; history and switch-away/back are a
 * fresh store read. All data is injected (mock WebSocket + injected loaders),
 * so these tests pin the browser behavior end to end without a server.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../shared/protocol.ts";
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

/** Two workspaces; session-2 (newest) is the latest across the whole tree. */
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
	{
		id: "ws-beta",
		path: "/opt/beta-project",
		title: "Beta",
		sessions: [
			{
				id: "session-3",
				label: "beta-project",
				updatedAt: 1700000200000,
			},
		],
	},
];

/** The store transcript for session-2: primary + two lane-worker children. */
const TRANSCRIPT_2: SessionTranscript = {
	primary: {
		sessionId: "session-2",
		lines: [{ text: "primary output", role: "output" }],
	},
	lanes: [
		{
			sessionId: "session-2-child-left",
			lines: [{ text: "left lane output", role: "output" }],
		},
		{
			sessionId: "session-2-child-right",
			lines: [{ text: "right lane output", role: "output" }],
		},
	],
};

/** The store transcript for session-3 (a different session). */
const TRANSCRIPT_3: SessionTranscript = {
	primary: {
		sessionId: "session-3",
		lines: [{ text: "other session", role: "output" }],
	},
	lanes: [],
};

/** A scriptable WebSocket fake, as in useRun.test.tsx. */
class FakeWebSocket {
	readyState = 0; // CONNECTING
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((message: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;

	open(): void {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}
	close(): void {
		this.readyState = 3; // CLOSED
		this.onclose?.();
	}
	send(data: string): void {
		this.sent.push(data);
	}
	emit(event: RunEvent): void {
		this.onmessage?.({ data: JSON.stringify(event) });
	}
}

/** Render the app with scripted loaders; returns the socket and the loaders. */
function renderApp(
	overrides: { readonly loadSessions?: () => Promise<SessionTree> } = {},
) {
	const socket = new FakeWebSocket();
	const loadSessions = vi.fn(
		overrides.loadSessions ?? (async () => SESSION_TREE),
	);
	const loadTranscript = vi.fn(async (sessionId: string) =>
		sessionId === "session-2" ? TRANSCRIPT_2 : TRANSCRIPT_3,
	);
	render(
		<App
			createSocket={() => socket as unknown as WebSocket}
			loadModels={async () => MODELS}
			loadSessions={loadSessions}
			loadTranscript={loadTranscript}
		/>,
	);
	return { socket, loadSessions, loadTranscript };
}

/** The transcript's primary output panel. */
function primaryOutput() {
	return screen.getByTestId("transcript-primary");
}

describe("session browser", () => {
	it("loads the tree once on page load, preselects the latest session, and highlights it", async () => {
		const { loadSessions } = renderApp();

		// The tree renders; the latest session (session-2) is preselected and
		// its row is highlighted.
		await waitFor(() =>
			expect(screen.getByTestId("session-row-session-2")).toHaveAttribute(
				"aria-current",
				"true",
			),
		);
		expect(screen.getByTestId("session-row-session-1")).not.toHaveAttribute(
			"aria-current",
		);
		expect(screen.getByTestId("session-row-session-3")).not.toHaveAttribute(
			"aria-current",
		);

		// Loaded once on page load, never auto-reloaded.
		expect(loadSessions).toHaveBeenCalledTimes(1);

		// The preselected session's transcript is read from the store.
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
	});

	it("clicking a session shows its transcript (primary + lane-worker children) and the run form", async () => {
		const user = userEvent.setup();
		const { loadTranscript } = renderApp();

		await waitFor(() =>
			expect(screen.getByTestId("session-row-session-2")).toHaveAttribute(
				"aria-current",
				"true",
			),
		);

		// The preselected session's transcript: primary + two lane workers.
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		const workers = screen.getAllByTestId("transcript-worker");
		expect(workers).toHaveLength(2);
		expect(workers[0]?.textContent ?? "").toContain("left lane output");
		expect(workers[1]?.textContent ?? "").toContain("right lane output");

		// The run form is present with the workspace dropdown removed.
		expect(screen.getByLabelText("Task")).toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Workspace" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();

		// Clicking another session switches the transcript (a fresh store read).
		await user.click(screen.getByTestId("session-row-session-3"));
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("other session"),
		);
		expect(screen.getByTestId("session-row-session-3")).toHaveAttribute(
			"aria-current",
			"true",
		);
		expect(screen.getByTestId("session-row-session-2")).not.toHaveAttribute(
			"aria-current",
		);
		expect(loadTranscript).toHaveBeenNthCalledWith(1, "session-2");
		expect(loadTranscript).toHaveBeenNthCalledWith(2, "session-3");
	});

	it("keeps submit disabled until a session is selected", async () => {
		renderApp({ loadSessions: async () => [] });

		// No sessions: nothing is preselected, submit stays disabled with the
		// hint, and the transcript panel invites a selection.
		await waitFor(() =>
			expect(
				screen.getByText(/Select a session to continue/),
			).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
		expect(
			screen.getByText(/Select a session to view its transcript/),
		).toBeInTheDocument();
	});

	it("renders the transcript window from the store — never assembled from streamed deltas", async () => {
		const { socket } = renderApp();

		// The transcript appears only once the store read resolves; no WS
		// event carries output text (the panels come from the store read).
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		expect(screen.getByTestId("transcript-session")).toHaveTextContent(
			"session-2",
		);

		// A lane lifecycle event changes the status chip, not the transcript.
		act(() => socket.open());
		act(() => socket.emit({ type: "lane/worker/started", laneId: "left" }));
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent(
			/^running/,
		);
		expect(primaryOutput()).toHaveTextContent("primary output");
	});

	it("re-reads the transcript live when the server pushes session/updated for the viewed session", async () => {
		const { socket, loadTranscript } = renderApp();
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		expect(loadTranscript).toHaveBeenCalledTimes(1);

		act(() => socket.open());
		act(() => socket.emit({ type: "session/updated", sessionId: "session-2" }));

		// The viewed session's store advanced: the transcript is re-read.
		await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
		expect(loadTranscript).toHaveBeenNthCalledWith(2, "session-2");
	});

	it("ignores session/updated for a session that is not being viewed", async () => {
		const { socket, loadTranscript } = renderApp();
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		expect(loadTranscript).toHaveBeenCalledTimes(1);

		act(() => socket.open());
		act(() => socket.emit({ type: "session/updated", sessionId: "session-3" }));

		// The update belongs to a different session: no re-read of the viewed
		// transcript.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(loadTranscript).toHaveBeenCalledTimes(1);
	});

	it("keeps the prior transcript window visible while a live refresh is in flight", async () => {
		// The first store read resolves immediately; the refresh read (from a
		// session/updated push) is deferred so the in-flight state is pinned.
		const socket = new FakeWebSocket();
		let call = 0;
		let resolveRefresh!: (transcript: SessionTranscript) => void;
		const loadTranscript = vi.fn((sessionId: string) => {
			call += 1;
			if (call === 1) {
				return Promise.resolve(TRANSCRIPT_2);
			}
			return new Promise<SessionTranscript>((resolve) => {
				resolveRefresh = resolve;
			});
		});
		render(
			<App
				createSocket={() => socket as unknown as WebSocket}
				loadModels={async () => MODELS}
				loadSessions={async () => SESSION_TREE}
				loadTranscript={loadTranscript}
			/>,
		);
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		expect(loadTranscript).toHaveBeenCalledTimes(1);

		act(() => socket.open());
		act(() => socket.emit({ type: "session/updated", sessionId: "session-2" }));

		// The refresh read is in flight: the prior window stays visible, never
		// a loading placeholder (output is read from the store, not streamed).
		await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(/Loading transcript/)).not.toBeInTheDocument();
		expect(primaryOutput()).toHaveTextContent("primary output");

		// The fresh read lands and the window updates in place.
		act(() => resolveRefresh(TRANSCRIPT_2));
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
	});

	it("re-reads the viewed transcript after a socket reconnect", async () => {
		const { socket, loadTranscript } = renderApp();
		await waitFor(() =>
			expect(primaryOutput()).toHaveTextContent("primary output"),
		);
		expect(loadTranscript).toHaveBeenCalledTimes(1);

		// First connect is not a reconnect; a drop and re-open is.
		act(() => socket.open());
		act(() => socket.close());
		act(() => socket.open());

		await waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(2));
		expect(loadTranscript).toHaveBeenNthCalledWith(2, "session-2");
	});

	it("starts the task field empty", async () => {
		renderApp();
		await waitFor(() => expect(screen.getByLabelText("Task")).toBeEnabled());
		expect(screen.getByLabelText("Task")).toHaveValue("");
	});
});
