import { describe, expect, it } from "vitest";
import {
	loadSessionsFromContext,
	loadTranscriptFromContext,
} from "../src/harness-adapters.ts";
import { registerLiveLanes } from "../src/live-lanes.ts";
import type { TranscriptEvent } from "../src/session-transcript.ts";

/** Build an event whose data shape matches what the seam's fold consumes:
 *  user/message reads text from data.content; assistant/message from
 *  data.message.content (the message is nested under .message). */
function msg(type: string, text: string): TranscriptEvent {
	if (type === "user/message") {
		return { type, data: { content: [{ type: "text", text }] } };
	}
	return { type, data: { message: { content: [{ type: "text", text }] } } };
}

/** A fake context exposing a fake session store under "sessionPersistence". */
function fakeContext(store: Record<string, readonly TranscriptEvent[]>) {
	return {
		get(name: string): unknown {
			if (name !== "sessionPersistence")
				throw new Error(`unexpected service ${name}`);
			return {
				inspect(id: string) {
					const events = store[id] ?? [];
					return { meta: { id }, events };
				},
			};
		},
	};
}

describe("loadTranscriptFromContext live lanes", () => {
	it("supplies the two live lane-worker windows alongside the primary when the run is active", async () => {
		const ctx = fakeContext({
			primary: [msg("user/message", "q")],
			"worker-left": [msg("assistant/message", "left out")],
			"worker-right": [msg("assistant/message", "right out")],
		});
		const load = loadTranscriptFromContext(ctx as never);
		const unLeft = registerLiveLanes("primary", [
			{ laneId: "left", workerSessionId: "worker-left" },
		]);
		const unRight = registerLiveLanes("primary", [
			{ laneId: "right", workerSessionId: "worker-right" },
		]);
		try {
			const transcript = await load("primary");
			expect(
				transcript.primary.lines.find((l) => l.role === "input")?.text,
			).toBe("q");
			expect(transcript.lanes.map((l) => l.sessionId).sort()).toEqual([
				"worker-left",
				"worker-right",
			]);
			expect(transcript.lanes.map((l) => l.lines[0].text).sort()).toEqual([
				"left out",
				"right out",
			]);
		} finally {
			unLeft();
			unRight();
		}
	});

	it("leaves lanes empty with no live run", async () => {
		const ctx = fakeContext({ primary: [msg("user/message", "q")] });
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("primary");
		expect(transcript.lanes).toEqual([]);
	});
});

describe("loadTranscriptFromContext spliced-session recovery", () => {
	/** A fake store whose inspect refuses the splice and readRaw serves the raw JSONL. */
	function splicedStore(opts: {
		rawContent: string;
		readRawThrows?: boolean;
		supportsRaw?: boolean;
	}) {
		return {
			supportsRawArtifacts: opts.supportsRaw ?? true,
			async inspect(_id: string) {
				throw new Error(
					"corrupt session log: seq gap in committed region at line 752 (expected 3307, got 3301)",
				);
			},
			async readRaw() {
				if (opts.readRawThrows) throw new Error("raw read boom");
				return { content: opts.rawContent, meta: { id: "spliced" } };
			},
		};
	}

	/** One JSONL line: header (line 0) plus event rows. */
	function jsonl(rows: readonly string[]): string {
		return ['{"version":1,"id":"spliced"}', ...rows].join("\n") + "\n";
	}

	it("recovers the committed history when inspect refuses a seq gap at a splice boundary", async () => {
		const raw = jsonl([
			// Parent prefix: contiguous seqs 0..3, ending in the splice boundary.
			JSON.stringify({
				type: "user/message",
				seq: 0,
				time: 1,
				data: { content: [{ type: "text", text: "parent prompt" }] },
			}),
			JSON.stringify({ type: "turn/start", seq: 1, time: 2, data: {} }),
			JSON.stringify({
				type: "agent/inbox/spliced",
				seq: 2,
				time: 3,
				data: {},
			}),
			JSON.stringify({ type: "session/end-seed", seq: 3, time: 4, data: {} }),
			// Child stream resumes with its own lower seqs.
			JSON.stringify({
				type: "user/message",
				seq: 0,
				time: 5,
				data: { content: [{ type: "text", text: "child prompt" }] },
			}),
			JSON.stringify({
				type: "assistant/message",
				seq: 1,
				time: 6,
				data: {
					message: { content: [{ type: "text", text: "child answer" }] },
				},
			}),
		]);
		const ctx = { get: () => splicedStore({ rawContent: raw }) };
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("spliced");
		// Both the parent prefix and the resumed child stream render.
		expect(transcript.primary.lines.map((l) => l.text)).toEqual([
			"parent prompt",
			"child prompt",
			"child answer",
		]);
	});

	it("rejects a genuine forward gap (no splice boundary licenses it)", async () => {
		const raw = jsonl([
			JSON.stringify({
				type: "user/message",
				seq: 0,
				time: 1,
				data: { content: [{ type: "text", text: "a" }] },
			}),
			// Forward gap: seq jumps 0 -> 5 with no boundary.
			JSON.stringify({
				type: "user/message",
				seq: 5,
				time: 2,
				data: { content: [{ type: "text", text: "b" }] },
			}),
		]);
		const ctx = { get: () => splicedStore({ rawContent: raw }) };
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("spliced");
		// The tolerant decode refuses; the loader falls back to the empty
		// transcript (the strict read already failed).
		expect(transcript.primary.lines).toEqual([]);
	});

	it("rejects a seq restart not licensed by a splice boundary", async () => {
		const raw = jsonl([
			JSON.stringify({
				type: "user/message",
				seq: 0,
				time: 1,
				data: { content: [{ type: "text", text: "a" }] },
			}),
			// Regression with no preceding boundary marker.
			JSON.stringify({
				type: "user/message",
				seq: 0,
				time: 2,
				data: { content: [{ type: "text", text: "b" }] },
			}),
		]);
		const ctx = { get: () => splicedStore({ rawContent: raw }) };
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("spliced");
		expect(transcript.primary.lines).toEqual([]);
	});

	it("falls back to the empty transcript when readRaw fails", async () => {
		const ctx = {
			get: () => splicedStore({ rawContent: "", readRawThrows: true }),
		};
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("spliced");
		expect(transcript.primary.lines).toEqual([]);
	});

	it("skips the tolerant path when the backend has no raw artifacts", async () => {
		const ctx = {
			get: () => splicedStore({ rawContent: "", supportsRaw: false }),
		};
		const load = loadTranscriptFromContext(ctx as never);
		const transcript = await load("spliced");
		expect(transcript.primary.lines).toEqual([]);
	});
});

describe("loadSessionsFromContext projection-cache reads", () => {
	/** A fake context exposing the registry, persistence, cache, and query. */
	function treeContext(opts: {
		registry?: unknown;
		persistence?: unknown;
		cache?: unknown;
		query?: unknown;
	}) {
		const services: Record<string, unknown> = {
			workspaceRegistry: opts.registry ?? {
				list: () => [
					{
						id: "ws",
						path: "/ws",
						title: "WS",
						sessionIds: ["s1", "s2", "s3"],
					},
				],
			},
			sessionPersistence: opts.persistence ?? {
				list: () => [
					{ id: "s1", createdAt: 100, cwd: "/ws" },
					{ id: "s2", createdAt: 200, cwd: "/ws" },
					{ id: "s3", createdAt: 300, cwd: "/ws" },
				],
				inspect: () => {
					throw new Error("inspect must not be called on cache hits");
				},
			},
			sessionProjectionCache: opts.cache,
			sessionQuery: opts.query,
		};
		return {
			get(name: string): unknown {
				if (!(name in services)) throw new Error(`unexpected service ${name}`);
				return services[name];
			},
		};
	}

	it("reads title and sessionListMetadata from the cache (zero-I/O) when present", async () => {
		const inspected: string[] = [];
		const ctx = treeContext({
			persistence: {
				list: () => [{ id: "s1", createdAt: 100, cwd: "/ws" }],
				inspect: (id: string) => {
					inspected.push(id);
					throw new Error("unreachable");
				},
			},
			cache: {
				cachedSnapshot(meta: { id: string }) {
					if (meta.id !== "s1") return undefined;
					return {
						asOfSeq: 42,
						values: {
							title: "Real cached title",
							sessionListMetadata: { blank: false, lastPromptAt: 900 },
						},
					};
				},
			},
		});
		const load = loadSessionsFromContext(ctx as never);
		const tree = await load();
		expect(tree[0].sessions).toEqual([
			{ id: "s1", label: "Real cached title", updatedAt: 900 },
		]);
		expect(inspected).toEqual([]);
	});

	it("derives updatedAt = max(createdAt, lastPromptAt) and keeps blank from the cache", async () => {
		const ctx = treeContext({
			cache: {
				cachedSnapshot() {
					return {
						asOfSeq: 1,
						values: {
							title: "t",
							sessionListMetadata: { blank: true, lastPromptAt: 50 },
						},
					};
				},
			},
		});
		const load = loadSessionsFromContext(ctx as never);
		const tree = await load();
		// blank: true hides the session from the tree (sessionVisible filter).
		expect(tree[0].sessions).toEqual([]);
	});

	it("falls back to the event fold + title read for a cache-missing session", async () => {
		const ctx = treeContext({
			persistence: {
				list: () => [{ id: "s2", createdAt: 200, cwd: "/ws" }],
				inspect: () => ({
					meta: { id: "s2" },
					events: [
						{ type: "turn/start", time: 300, data: {} },
						{
							type: "user/message",
							time: 400,
							data: { source: { kind: "user" } },
						},
					],
				}),
			},
			cache: { cachedSnapshot: () => undefined },
			query: {
				readTitleSnapshots: async (ids: string[]) =>
					ids.map((sessionId) => ({
						sessionId,
						status: "fulfilled" as const,
						value: { title: { title: "fold title" } },
					})),
			},
		});
		const load = loadSessionsFromContext(ctx as never);
		const tree = await load();
		expect(tree[0].sessions).toEqual([
			{ id: "s2", label: "fold title", updatedAt: 400 },
		]);
	});

	it("treats an unreadable cache-missing session as non-blank at createdAt", async () => {
		const ctx = treeContext({
			persistence: {
				list: () => [{ id: "s3", createdAt: 300, cwd: "/ws" }],
				inspect: () => {
					throw new Error("boom");
				},
			},
			cache: { cachedSnapshot: () => undefined },
		});
		const load = loadSessionsFromContext(ctx as never);
		const tree = await load();
		// The unreadable session has no stored title, so it labels by the cwd
		// folder basename (DSH displayTitleOf), never "Untitled session".
		expect(tree[0].sessions).toEqual([
			{ id: "s3", label: "ws", updatedAt: 300 },
		]);
	});

	it("resolves to an empty tree when the cache read throws", async () => {
		const ctx = treeContext({
			cache: {
				cachedSnapshot: () => {
					throw new Error("cache boom");
				},
			},
		});
		const load = loadSessionsFromContext(ctx as never);
		const tree = await load();
		expect(tree).toEqual([]);
	});
});

describe("watchSessionFromContext live-lane refresh", () => {
	it("fires the update when a live lane child of the watched session streams an assistant chunk", async () => {
		const watched = "primary";
		const child = "worker-left";
		const un = registerLiveLanes(watched, [
			{ laneId: "left", workerSessionId: child },
		]);
		try {
			let fired = 0;
			// A fake context whose on() captures the listener, so the test can emit events.
			let listener:
				| ((session: { id: string }, event: { type: string }) => void)
				| undefined;
			const ctx = {
				on(
					_name: string,
					cb: (session: { id: string }, event: { type: string }) => void,
				) {
					listener = cb;
					return () => {
						listener = undefined;
					};
				},
			};
			const { watchSessionFromContext } = await import(
				"../src/harness-adapters"
			);
			const watch = watchSessionFromContext(ctx as never);
			const dispose = watch(watched, () => {
				fired += 1;
			});
			// A chunk on the live lane child should fire the watch for the primary.
			listener?.({ id: child }, { type: "assistant/chunk" });
			expect(fired).toBe(1);
			// A chunk on an unrelated session should not.
			listener?.({ id: "unrelated" }, { type: "assistant/chunk" });
			expect(fired).toBe(1);
			// A chunk on the watched session itself still fires.
			listener?.({ id: watched }, { type: "assistant/chunk" });
			expect(fired).toBe(2);
			dispose();
		} finally {
			un();
		}
	});
});
