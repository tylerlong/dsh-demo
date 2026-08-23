/**
 * session-tree.test.ts — seam tests for the read-only session-tree and
 * transcript reads (ticket #38).
 *
 * The session browser's left panel is a two-level tree (workspace → its
 * sessions) sourced read-only from the shared workspace registry and session
 * store; the right panel renders each agent's output (the primary session and
 * its lane-worker children) from the store's recent ~100-line window. These
 * tests exercise the two seams (convertSessionTree / convertSessionTranscript)
 * with injected fakes — no real harness — asserting the tree shape, the
 * strict read-only contract (only list() / inspect() are ever called, never a
 * mutation), and the recent-window behavior.
 */
import { describe, expect, it } from "vitest";
import {
	convertSessionTranscript,
	TRANSCRIPT_WINDOW_LINES,
	type TranscriptEvent,
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
	headers: readonly { readonly id: string; readonly createdAt: number }[],
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

/** A transcript store fake: headers + per-session event logs, call-recorded. */
function fakeTranscriptStore(
	headers: readonly { readonly id: string; readonly parentSession?: string }[],
	eventsBySession: Readonly<Record<string, readonly TranscriptEvent[]>>,
): {
	readonly calls: readonly string[];
	readonly store: Parameters<typeof convertSessionTranscript>[0];
} {
	const calls: string[] = [];
	return {
		calls,
		store: {
			list() {
				calls.push("store.list");
				return Promise.resolve(headers);
			},
			inspect(id: string) {
				calls.push(`store.inspect:${id}`);
				const events = eventsBySession[id] ?? [];
				return Promise.resolve({
					meta: { id },
					events,
				});
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
		} as unknown as Parameters<typeof convertSessionTranscript>[0],
	};
}

describe("session tree seam", () => {
	it("yields a two-level tree of workspaces with their sessions (id, createdAt)", async () => {
		const { registry } = fakeRegistry([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessionIds: ["session-1", "session-2"],
			},
			{
				id: "ws-beta",
				path: "/opt/beta-project",
				title: "Beta",
				sessionIds: ["session-3"],
			},
			{
				id: "ws-empty",
				path: "/opt/empty-project",
				title: "Empty",
				sessionIds: [],
			},
		]);
		const { store } = fakeStore([
			{ id: "session-1", createdAt: 1700000000000 },
			{ id: "session-2", createdAt: 1700000500000 },
			{ id: "session-3", createdAt: 1700001000000 },
		]);

		const tree = await convertSessionTree(registry, store);

		expect(tree).toEqual([
			{
				id: "ws-alpha",
				path: "/opt/alpha-project",
				title: "Alpha",
				sessions: [
					{ id: "session-1", createdAt: 1700000000000 },
					{ id: "session-2", createdAt: 1700000500000 },
				],
			},
			{
				id: "ws-beta",
				path: "/opt/beta-project",
				title: "Beta",
				sessions: [{ id: "session-3", createdAt: 1700001000000 }],
			},
			{
				id: "ws-empty",
				path: "/opt/empty-project",
				title: "Empty",
				sessions: [],
			},
		]);
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
			{ id: "session-1", createdAt: 1700000000000 },
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
	it("returns the primary session's window plus its lane-worker children found via parentSession", async () => {
		const { store } = fakeTranscriptStore(
			[
				{ id: "session-primary" },
				{ id: "session-left", parentSession: "session-primary" },
				{ id: "session-right", parentSession: "session-primary" },
				{ id: "session-other" },
			],
			{
				"session-primary": [
					messageEvent("user/message", "task: compare two models"),
					messageEvent("assistant/message", "spawning workers"),
				],
				"session-left": [messageEvent("assistant/message", "left answer")],
				"session-right": [messageEvent("assistant/message", "right answer")],
			},
		);

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary).toEqual({
			sessionId: "session-primary",
			lines: ["task: compare two models", "spawning workers"],
		});
		expect(transcript.lanes).toEqual([
			{ sessionId: "session-left", lines: ["left answer"] },
			{ sessionId: "session-right", lines: ["right answer"] },
		]);
	});

	it("returns an empty window for a session with no message-producing events", async () => {
		const { store } = fakeTranscriptStore([{ id: "session-primary" }], {
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
		const { store } = fakeTranscriptStore([{ id: "session-primary" }], {
			"session-primary": [
				messageEvent("assistant/message", longLines.join("\n")),
			],
		});

		const transcript = await convertSessionTranscript(store, "session-primary");

		expect(transcript.primary.lines).toHaveLength(TRANSCRIPT_WINDOW_LINES);
		// The window is the tail: the last 100 lines, in order.
		expect(transcript.primary.lines[0]).toBe("line-50");
		expect(transcript.primary.lines.at(-1)).toBe(
			`line-${TRANSCRIPT_WINDOW_LINES + 49}`,
		);
	});

	it("is strictly read-only: only store.list() and store.inspect() are called", async () => {
		const { store, calls } = fakeTranscriptStore(
			[
				{ id: "session-primary" },
				{ id: "session-left", parentSession: "session-primary" },
			],
			{
				"session-primary": [messageEvent("assistant/message", "primary text")],
				"session-left": [messageEvent("assistant/message", "left text")],
			},
		);

		await convertSessionTranscript(store, "session-primary");

		expect(calls).toEqual([
			"store.list",
			"store.inspect:session-left",
			"store.inspect:session-primary",
		]);
	});
});
