/**
 * session-tree.test.ts — seam tests for the read-only session-tree and
 * transcript reads (ticket #38; child ticket #46 makes the transcript read
 * primary-only with per-line roles and live lanes).
 *
 * The session browser's left panel is a two-level tree (workspace → its
 * sessions) sourced read-only from the shared workspace registry and session
 * store; the right panel renders the selected session's own output from the
 * store's recent prompt/answer window — primary-only (child #46): stored
 * subagent children are never read, each line carries a role, and live lane
 * windows of our own in-progress run are supplied separately. These tests
 * exercise the two seams (convertSessionTree / convertSessionTranscript) with
 * injected fakes — no real harness — asserting the tree shape, the strict
 * read-only contract (only list() / inspect() are ever called, never a
 * mutation), and the recent-window behavior.
 */
import { describe, expect, it } from "vitest";
import {
	convertSessionTranscript,
	TRANSCRIPT_WINDOW_PAIRS,
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
	archivedSessionIds: readonly string[] = [],
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
			get archivedSessionIds() {
				calls.push("registry.archivedSessionIds");
				return archivedSessionIds;
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
		readonly updatedAt: number;
		readonly origin?: "subagent";
		readonly blank?: boolean;
		readonly label?: string;
		readonly cwd?: string;
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
	if (type === "user/message") {
		return {
			type,
			data: {
				content: [{ type: "text", text }],
				source: { kind: "user" },
			},
		};
	}
	return {
		type,
		data: { turn: 0, step: 0, message: { content: [{ type: "text", text }] } },
	};
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
	it("labels each session by stored title, else workspace folder basename, else id (no placeholder)", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1", "session-2", "session-3"],
			},
			{
				id: "ws-empty",
				path: "/opt/empty-project",
				title: "Empty",
				sessionIds: [],
			},
		]);
		const { store } = fakeStore([
			{
				id: "session-1",
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
				label: "Alpha primary",
			},
			{
				id: "session-2",
				createdAt: 1700000000000,
				updatedAt: 1700000500000,
				cwd: "/opt/alpha-project",
			},
			{
				id: "session-3",
				createdAt: 1700000000000,
				updatedAt: 1700000600000,
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// title → cwd basename → id; no "Untitled session" placeholder.
		// (Sessions are ordered by updatedAt desc, so session-3 leads.)
		expect(tree[0]?.sessions).toEqual([
			{ id: "session-3", label: "session-3", updatedAt: 1700000600000 },
			{ id: "session-2", label: "alpha-project", updatedAt: 1700000500000 },
			{ id: "session-1", label: "Alpha primary", updatedAt: 1700000000000 },
		]);
	});

	it("falls back to the folder basename only when no stored title is set", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["with-title", "with-cwd", "trailing-slash"],
			},
		]);
		const { store } = fakeStore([
			{
				id: "with-title",
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
				label: "Stored title",
				cwd: "/opt/alpha-project",
			},
			{
				id: "with-cwd",
				createdAt: 1700000000000,
				updatedAt: 1700000100000,
				cwd: "/opt/alpha-project/sub",
			},
			{
				id: "trailing-slash",
				createdAt: 1700000000000,
				updatedAt: 1700000200000,
				cwd: "/opt/alpha-project/",
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// A stored title wins over the cwd basename; a trailing slash is
		// stripped; the deepest folder basename is used.
		expect(tree[0]?.sessions.map((s) => s.label)).toEqual([
			"alpha-project",
			"sub",
			"Stored title",
		]);
	});

	it("orders sessions by last updated within a workspace and caps at the top 5", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["s1", "s2", "s3", "s4", "s5", "s6"],
			},
		]);
		const { store } = fakeStore([
			{ id: "s1", createdAt: 1700000000000, updatedAt: 1700000000000 },
			{ id: "s2", createdAt: 1700000000000, updatedAt: 1700000700000 },
			{ id: "s3", createdAt: 1700000000000, updatedAt: 1700000400000 },
			{ id: "s4", createdAt: 1700000000000, updatedAt: 1700000200000 },
			{ id: "s5", createdAt: 1700000000000, updatedAt: 1700000600000 },
			{ id: "s6", createdAt: 1700000000000, updatedAt: 1700000800000 },
		]);

		const tree = await convertSessionTree(registry, store);

		// By last updated: s6, s2, s5, s3, s4; s1 (oldest) is dropped (cap 5).
		expect(tree[0]?.sessions.map((s) => s.id)).toEqual([
			"s6",
			"s2",
			"s5",
			"s3",
			"s4",
		]);
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
			{
				id: "primary",
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
				label: "Main",
			},
			{
				id: "lane-left",
				createdAt: 1700000100000,
				updatedAt: 1700000100000,
				origin: "subagent",
				label: "Left lane",
			},
			{
				id: "lane-right",
				createdAt: 1700000200000,
				updatedAt: 1700000200000,
				origin: "subagent",
				label: "Right lane",
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// Both lane-worker subagents are filtered; only the top-level survives.
		expect(tree[0]?.sessions).toEqual([
			{ id: "primary", label: "Main", updatedAt: 1700000000000 },
		]);
	});

	it("filters out blank sessions (no turn ever ran), matching DSH web sessionVisible", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["active", "blank-session"],
			},
		]);
		const { store } = fakeStore([
			{ id: "active", createdAt: 1700000000000, updatedAt: 1700000500000 },
			{
				id: "blank-session",
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
				blank: true,
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// The blank session never ran a turn; it is hidden like DSH web hides it.
		expect(tree[0]?.sessions).toEqual([
			{ id: "active", label: "active", updatedAt: 1700000500000 },
		]);
	});

	it("hides archived sessions via the registry's archived ids", async () => {
		const { registry } = fakeRegistry(
			[
				{
					id: "ws-alpha",
					path: "/opt/alpha-project",
					title: "Alpha",
					sessionIds: ["active", "archived-one", "archived-two"],
				},
			],
			["archived-one", "archived-two"],
		);
		const { store } = fakeStore([
			{ id: "active", createdAt: 1700000000000, updatedAt: 1700000500000 },
			{
				id: "archived-one",
				createdAt: 1700000000000,
				updatedAt: 1700000600000,
			},
			{
				id: "archived-two",
				createdAt: 1700000000000,
				updatedAt: 1700000700000,
			},
		]);

		const tree = await convertSessionTree(registry, store);

		// Archived sessions never appear, even though they are the most recent.
		expect(tree[0]?.sessions).toEqual([
			{ id: "active", label: "active", updatedAt: 1700000500000 },
		]);
	});

	it("keeps workspaces in the durable registry order (not re-sorted by recency)", async () => {
		const { registry } = fakeRegistry([
			{ id: "ws-old", path: "/opt/old", title: "Old", sessionIds: ["s1"] },
			{ id: "ws-new", path: "/opt/new", title: "New", sessionIds: ["s2"] },
			{ id: "ws-empty", path: "/opt/empty", title: "Empty", sessionIds: [] },
		]);
		const { store } = fakeStore([
			{ id: "s1", createdAt: 1700000200000, updatedAt: 1700000200000 },
			{ id: "s2", createdAt: 1700000800000, updatedAt: 1700000800000 },
		]);

		const tree = await convertSessionTree(registry, store);

		// The registry lists ws-old, ws-new, ws-empty; durable order is kept,
		// even though ws-new has the newer session.
		expect(tree.map((w) => w.id)).toEqual(["ws-old", "ws-new", "ws-empty"]);
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
			{ id: "session-1", createdAt: 1700000000000, updatedAt: 1700000000000 },
		]);

		const tree = await convertSessionTree(registry, store);

		expect(tree[0]?.sessions).toEqual([
			{ id: "session-1", label: "session-1", updatedAt: 1700000000000 },
		]);
	});

	it("is strictly read-only: only registry.list(), registry.archivedSessionIds, and store.list() are called", async () => {
		const { registry, calls: registryCalls } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1"],
			},
		]);
		const { store, calls: storeCalls } = fakeStore([
			{ id: "session-1", createdAt: 1700000000000, updatedAt: 1700000000000 },
		]);

		await convertSessionTree(registry, store);

		expect(registryCalls).toEqual([
			"registry.list",
			"registry.archivedSessionIds",
		]);
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

	it("tags each line with its role: user= input, assistant= output; hides tool results and non-user sources", async () => {
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "the request"),
				messageEvent("assistant/message", "the reply"),
				// The model's tool-invocation history is not user-facing.
				messageEvent("tool/result", "the tool output"),
				// A harness-internal user-source (skill catalog, etc.) is not a
				// typed prompt and is hidden.
				{
					type: "user/message",
					data: {
						content: [{ type: "text", text: "skill reminder" }],
						source: { kind: "skill-catalog", form: "catalog" },
					},
				},
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toEqual([
			{ text: "the request", role: "input" },
			{ text: "the reply", role: "output" },
		]);
	});

	it("hides harness-internal user sources and thinking blocks; shows only typed prompts and text replies", async () => {
		const { store } = fakeTranscriptStore({
			"session-primary": [
				{
					type: "user/message",
					data: {
						content: [{ type: "text", text: "real prompt" }],
						source: { kind: "user" },
					},
				},
				// A skill-invocation body is harness context, not the user's words.
				{
					type: "user/message",
					data: {
						content: [{ type: "text", text: "<skill_content…>" }],
						source: {
							kind: "skill-invocation",
							name: "grill-with-docs",
							form: "instructions",
						},
					},
				},
				// Teacher-inserted agent-instructions / plugin context are hidden too.
				{
					type: "user/message",
					data: {
						content: [{ type: "text", text: "context injection" }],
						source: { kind: "agent-instructions", form: "instructions" },
					},
				},
				{
					type: "assistant/message",
					data: {
						turn: 0,
						step: 0,
						message: {
							content: [
								// Thinking is a separate block type, never shown.
								{ type: "reasoning", text: "the model's hidden reasoning" },
								{ type: "tool-call", name: "read", input: "{}" },
								// The real user-facing reply.
								{ type: "text", text: "the answer" },
							],
						},
					},
				},
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		// Only the typed prompt and the assistant's text reply remain; every
		// harness-internal input source and thinking block is filtered.
		expect(transcript.primary.lines).toEqual([
			{ text: "real prompt", role: "input" },
			{ text: "the answer", role: "output" },
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

	it("keeps only the recent one prompt/answer pair when more pairs exist", async () => {
		// Three full pairs (prompt + answer each), so the default one-pair
		// window shows only the newest pair.
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "prompt one"),
				messageEvent("assistant/message", "answer one"),
				messageEvent("user/message", "prompt two"),
				messageEvent("assistant/message", "answer two"),
				messageEvent("user/message", "prompt three"),
				messageEvent("assistant/message", "answer three"),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		// The newest pair only: prompt three + answer three.
		expect(transcript.primary.lines).toEqual([
			{ text: "prompt three", role: "input" },
			{ text: "answer three", role: "output" },
		]);
		// More pairs exist before the window, so the page can offer "load more".
		expect(transcript.moreBefore).toBe(true);
	});

	it("grows the window backward by the requested pair limit (load more)", async () => {
		// Three pairs, request the last two.
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "prompt one"),
				messageEvent("assistant/message", "answer one"),
				messageEvent("user/message", "prompt two"),
				messageEvent("assistant/message", "answer two"),
				messageEvent("user/message", "prompt three"),
				messageEvent("assistant/message", "answer three"),
			],
		});

		const transcript = await convertSessionTranscript(
			store,
			"session-primary",
			[],
			TRANSCRIPT_WINDOW_PAIRS + 1,
		);

		// The last two pairs, in order.
		expect(transcript.primary.lines).toEqual([
			{ text: "prompt two", role: "input" },
			{ text: "answer two", role: "output" },
			{ text: "prompt three", role: "input" },
			{ text: "answer three", role: "output" },
		]);
		// 3 stored pairs > 2 requested: more pairs remain before the window.
		expect(transcript.moreBefore).toBe(true);
	});

	it("reports moreBefore=false when the whole transcript fits the window", async () => {
		const { store } = fakeTranscriptStore({
			"session-primary": [
				messageEvent("user/message", "only prompt"),
				messageEvent("assistant/message", "only answer"),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toEqual([
			{ text: "only prompt", role: "input" },
			{ text: "only answer", role: "output" },
		]);
		expect(transcript.moreBefore).toBe(false);
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
