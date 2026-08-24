/**
 * session-tree.test.ts — seam tests for the read-only session-tree and
 * transcript reads (ticket #38; child ticket #46 makes the transcript read
 * primary-only with per-line roles and live lanes).
 *
 * The session browser's left panel is a two-level tree (workspace → its
 * sessions) sourced read-only from the shared workspace registry and session
 * store; the right panel renders the selected session's own output from the
 * store's recent ~100-line window — primary-only (child #46): stored subagent
 * children are never read, each line carries a role, and live lane windows of
 * our own in-progress run are supplied separately. These tests exercise the
 * two seams (convertSessionTree / convertSessionTranscript) with injected
 * fakes — no real harness — asserting the tree shape, the strict read-only
 * contract (only list() / inspect() are ever called, never a mutation), and
 * the recent-window behavior.
 */
import { describe, expect, it } from "vitest";
import {
	convertSessionTranscript,
	TRANSCRIPT_WINDOW_LINES,
	type TranscriptEvent,
	type TranscriptWindow,
} from "../src/session-transcript.ts";
import { convertSessionTree } from "../src/session-tree.ts";

/** A fake workspace registry recording every call; mutations throw. */
function fakeRegistry(
	workspaces: readonly {
		readonly id: string;
		readonly path: string;
		readonly title: string;
		readonly sessionIds: readonly string[];
	}[],
): {
	readonly calls: readonly string[];
	readonly registry: Parameters<typeof convertSessionTree>[0];
} {
	const calls: string[] = [];
	return {
		calls,
		registry: {
			list() {
				calls.push("registry.list");
				return workspaces;
			},
			// Mutation surface DSH web owns; the seam must never reach it.
			create() {
				throw new Error("registry mutation called");
			},
			delete() {
				throw new Error("registry mutation called");
			},
			insertBefore() {
				throw new Error("registry mutation called");
			},
			attachSession() {
				throw new Error("registry mutation called");
			},
			setTitle() {
				throw new Error("registry mutation called");
			},
			archiveSession() {
				throw new Error("registry mutation called");
			},
		} as unknown as Parameters<typeof convertSessionTree>[0],
	};
}

/** A fake session store recording every call; mutations throw. */
function fakeStore(
	headers: readonly {
		readonly id: string;
		readonly createdAt: number;
		readonly origin?: "subagent";
		readonly label?: string;
	}[],
): {
	readonly calls: readonly string[];
	readonly store: Parameters<typeof convertSessionTree>[1];
} {
	const calls: string[] = [];
	return {
		calls,
		store: {
			list() {
				calls.push("store.list");
				return Promise.resolve(headers);
			},
			create() {
				throw new Error("store mutation called");
			},
			append() {
				throw new Error("store mutation called");
			},
			prepare() {
				throw new Error("store mutation called");
			},
			resume() {
				throw new Error("store mutation called");
			},
		} as unknown as Parameters<typeof convertSessionTree>[1],
	};
}

/** One message-producing event, shaped like the store's surface events. */
function messageEvent(
	type: "user/message" | "assistant/message" | "tool/result",
	text: string,
): TranscriptEvent {
	const data =
		type === "user/message"
			? { content: [{ type: "text", text }] }
			: { turn: 0, step: 0, message: { content: [{ type: "text", text }] } };
	return { type, data };
}

/** A non-message event (boundary/chunk/log-only) contributing no text. */
function nonMessageEvent(type: string): TranscriptEvent {
	return { type, data: {} };
}

/** A transcript store fake: per-session event logs, call-recorded. */
function fakeTranscriptStore(
	eventsBySession: Readonly<Record<string, readonly TranscriptEvent[]>>,
): {
	readonly calls: readonly string[];
	readonly store: Parameters<typeof convertSessionTranscript>[0];
} {
	const calls: string[] = [];
	return {
		calls,
		store: {
			inspect(id: string) {
				calls.push(`store.inspect:${id}`);
				const events = eventsBySession[id] ?? [];
				return Promise.resolve({
					meta: { id },
					events,
				});
			},
			// Mutation surface DSH web owns; the seam must never reach it.
			create() {
				throw new Error("store mutation called");
			},
			append() {
				throw new Error("store mutation called");
			},
			prepare() {
				throw new Error("store mutation called");
			},
			resume() {
				throw new Error("store mutation called");
			},
		} as unknown as Parameters<typeof convertSessionTranscript>[0],
	};
}

describe("session tree seam", () => {
	it("yields a two-level tree with each session labeled (stored label, else placeholder)", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1", "session-2"],
			},
			{
				id: "ws-empty",
				path: "/opt/empty-project",
				title: "Empty",
				sessionIds: [],
			},
		]);
		const { store } = fakeStore([
			{ id: "session-1", createdAt: 1700000000000, label: "Alpha primary" },
			{ id: "session-2", createdAt: 1700000500000 },
		]);

		const tree = await convertSessionTree(registry, store);

		// A stored label is surfaced; a session without one gets the placeholder.
		// (Sessions are also ordered newest-first, so session-2 leads.)
		expect(tree[0]?.sessions).toEqual([
			{ id: "session-2", label: "Untitled session", createdAt: 1700000500000 },
			{ id: "session-1", label: "Alpha primary", createdAt: 1700000000000 },
		]);
	});

	it("orders sessions newest-first within a workspace and caps at the top 3", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["s1", "s2", "s3", "s4", "s5"],
			},
		]);
		const { store } = fakeStore([
			{ id: "s1", createdAt: 1700000000000 },
			{ id: "s2", createdAt: 1700000700000 },
			{ id: "s3", createdAt: 1700000400000 },
			{ id: "s4", createdAt: 1700000200000 },
			{ id: "s5", createdAt: 1700000600000 },
		]);

		const tree = await convertSessionTree(registry, store);

		// Newest first (s2, s5, s3); s4 and s1 (the oldest two) are dropped.
		expect(tree[0]?.sessions.map((s) => s.id)).toEqual(["s2", "s5", "s3"]);
	});

	it("filters out subagent sessions (origin: 'subagent'), keeping only top-level conversations", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["primary", "lane-left", "lane-right"],
			},
		]);
		const { store } = fakeStore([
			{ id: "primary", createdAt: 1700000000000, label: "Main" },
			{
				id: "lane-left",
				createdAt: 1700000100000,
				origin: "subagent",
				label: "Left lane",
			},
			{
				id: "lane-right",
				createdAt: 1700000200000,
				origin: "subagent",
				label: "Right lane",
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// Both lane-worker subagents are filtered; only the top-level survives.
		expect(tree[0]?.sessions).toEqual([
			{ id: "primary", label: "Main", createdAt: 1700000000000 },
		]);
	});

	it("orders workspaces by their newest session, newest workspace first", async () => {
		const { registry } = fakeRegistry([
			{ id: "ws-old", path: "/opt/old", title: "Old", sessionIds: ["s1"] },
			{ id: "ws-new", path: "/opt/new", title: "New", sessionIds: ["s2"] },
			{ id: "ws-empty", path: "/opt/empty", title: "Empty", sessionIds: [] },
		]);
		const { store } = fakeStore([
			{ id: "s1", createdAt: 1700000200000 },
			{ id: "s2", createdAt: 1700000800000 },
		]);

		const tree = await convertSessionTree(registry, store);

		// ws-new (newest session) first, then ws-old, then the empty workspace.
		expect(tree.map((w) => w.id)).toEqual(["ws-new", "ws-old", "ws-empty"]);
	});

	it("omits sessions the registry lists but the store does not know", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1", "session-gone"],
			},
		]);
		const { store } = fakeStore([
			{ id: "session-1", createdAt: 1700000000000 },
		]);

		const tree = await convertSessionTree(registry, store);

		expect(tree[0]?.sessions).toEqual([
			{ id: "session-1", label: "Untitled session", createdAt: 1700000000000 },
		]);
	});

	it("is strictly read-only: only registry.list() and store.list() are called", async () => {
		const { registry, calls: registryCalls } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1"],
			},
		]);
		const { store, calls: storeCalls } = fakeStore([
			{ id: "session-1", createdAt: 1700000000000 },
		]);

		await convertSessionTree(registry, store);

		expect(registryCalls).toEqual(["registry.list"]);
		expect(storeCalls).toEqual(["store.list"]);
	});
});

describe("session transcript seam", () => {
	it("is primary-only: reads only the selected session, never stored subagent children", async () => {
		// The store holds the selected session plus two stored subagent children
		// (the lane workers a past run left behind). The read must not load them.
		const { store, calls } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "task: compare two models"),
				messageEvent("assistant/message", "spawning workers"),
			],
			"session-left": [messageEvent("assistant/message", "left answer")],
			"session-right": [messageEvent("assistant/message", "right answer")],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary).toEqual({
			sessionId: "session-primary",
			lines: [
				{ text: "task: compare two models", role: "input" },
				{ text: "spawning workers", role: "output" },
			],
		});
		// No live lanes: nothing from the store's subagent children.
		expect(transcript.lanes).toEqual([]);
		expect(calls).toEqual(["store.inspect:session-primary"]);
	});

	it("tags each line with its role: user= input, assistant= output, tool= default", async () => {
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "the request"),
				messageEvent("assistant/message", "the reply"),
				messageEvent("tool/result", "the tool output"),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toEqual([
			{ text: "the request", role: "input" },
			{ text: "the reply", role: "output" },
			{ text: "the tool output", role: "default" },
		]);
	});

	it("carries the live lane windows of our own in-progress run when supplied", async () => {
		const { store, calls } = fakeTranscriptStore({
			"session-primary": [messageEvent("assistant/message", "primary text")],
			"session-left": [messageEvent("assistant/message", "left live")],
			"session-right": [messageEvent("assistant/message", "right live")],
		});

		// The two lane workers our live run just created, supplied in-memory
		// (this run's children) — never read from stored history.
		const liveLanes: TranscriptWindow[] = [
			{
				sessionId: "session-left",
				lines: [{ text: "left live", role: "output" }],
			},
			{
				sessionId: "session-right",
				lines: [{ text: "right live", role: "output" }],
			},
		];
		const transcript = await convertSessionTranscript(
			store,
			"session-primary",
			liveLanes,
		);

		expect(transcript.lanes).toEqual(liveLanes);
		// Only the primary is inspected; the live lanes are never store reads.
		expect(calls).toEqual(["store.inspect:session-primary"]);
	});

	it("returns an empty window for a session with no message-producing events", async () => {
		const { store } = fakeTranscriptStore({
			"session-primary": [
				nonMessageEvent("turn/start"),
				nonMessageEvent("assistant/chunk"),
				nonMessageEvent("session/end-seed"),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toEqual([]);
		expect(transcript.lanes).toEqual([]);
	});

	it("keeps only the recent ~100-line window when the transcript is longer", async () => {
		const longLines = Array.from(
			{ length: TRANSCRIPT_WINDOW_LINES + 50 },
			(_, i) => `line-${i}`,
		);
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("assistant/message", longLines.join("\n")),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toHaveLength(TRANSCRIPT_WINDOW_LINES);
		// The window is the tail: the last 100 lines, in order.
		expect(transcript.primary.lines[0]).toEqual({
			text: "line-50",
			role: "output",
		});
		expect(transcript.primary.lines.at(-1)).toEqual({
			text: `line-${TRANSCRIPT_WINDOW_LINES + 49}`,
			role: "output",
		});
	});

	it("is strictly read-only: only store.inspect() is called, no list()", async () => {
		const { store, calls } = fakeTranscriptStore({
			"session-primary": [messageEvent("assistant/message", "primary text")],
			"session-left": [messageEvent("assistant/message", "left text")],
		});

		await convertSessionTranscript(store, "session-primary");

		expect(calls).toEqual(["store.inspect:session-primary"]);
	});
});
