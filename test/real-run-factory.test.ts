/**
 * real-run-factory.test.ts — tests for the harness-backed run factory (#5, #40).
 *
 * The factory is a thin composition of harness primitives (agents.resume,
 * subagents.start, session event watching, cancellation). These tests drive it
 * against a fake harness context — a fake llm registry, agent factory, and
 * subagent provider — so no real model call or harness boot is involved. They
 * pin the orchestration shape (the requested session resumed on the primary
 * model, its saved context loaded so new turns append to that same session,
 * the run workspace taken from the resumed session's header cwd, two read-only
 * workers on the lane models), the event translation (session text deltas →
 * lane/worker/delta, completion → lane/worker/done, run/done once both lanes
 * settle, cancel → run/canceled), and the read-only tool filter.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SubagentResult, SubagentRun } from "@deepseek-ai/dsh-subagent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunFactory, WORKER_TOOLS } from "../src/real-run-factory.ts";
import type { RunEvent, RunRequest, StartRun } from "../src/run-factory.ts";
import { resolveWorkspace } from "../src/workspace.ts";

const MODELS = [
	{
		provider: "openrouter",
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
	},
	{ provider: "openrouter", id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna" },
];

/** A workspace folder the run agents act on; a real dir, refreshed per test. */
let WORKSPACE = "";
beforeEach(() => {
	WORKSPACE = mkdtempSync(join(tmpdir(), "dsh-ws-"));
});
afterEach(() => {
	if (WORKSPACE !== "") {
		rmSync(WORKSPACE, { recursive: true, force: true });
	}
});

/** The session id every run resumes in these tests (the seam carries it). */
const SESSION_ID = "session-resume-me";

/** Build the default request against the resumed session. */
function baseRequest(overrides: Partial<RunRequest> = {}): RunRequest {
	return {
		task: "Compare the sea and the sky",
		primaryModel: "deepseek/deepseek-v4-flash-0731",
		laneModels: {
			left: "deepseek/deepseek-v4-flash-0731",
			right: "openai/gpt-5.6-luna",
		},
		sessionId: SESSION_ID,
		...overrides,
	};
}

/** A promise the test resolves to settle a spawned run result. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface SpawnedRun {
	readonly run: SubagentRun;
	readonly request: Record<string, unknown>;
	readonly settle: (result: SubagentResult) => void;
	readonly signal: AbortSignal;
}

interface ResumedAgent {
	readonly handle: AgentHandle;
	readonly opts: Record<string, unknown>;
}

interface FakeHarness {
	ctx: Context;
	models: typeof MODELS;
	resumed: ResumedAgent[];
	spawned: SpawnedRun[];
	sessionListeners: Array<(session: { id: string }, event: unknown) => void>;
	orchestratorCalls: { whenIdle: number; followup: number; cancel: number };
	/** The cwd the fake's resumed session header carried (the run workspace source). */
	headerCwd: string | undefined;
}

/** Build a fake harness context the factory can drive. */
function makeHarness(
	models: typeof MODELS = MODELS,
	options: { headerCwd?: string; resumeError?: unknown } = {},
): FakeHarness {
	const resumed: ResumedAgent[] = [];
	const spawned: SpawnedRun[] = [];
	const sessionListeners: FakeHarness["sessionListeners"] = [];
	const orchestratorCalls = { whenIdle: 0, followup: 0, cancel: 0 };

	let spawnSeq = 0;
	const context = {
		llm: {
			listProviders: () => [{ id: "openrouter" }],
			listModels: () => Promise.resolve(models),
		},
		agents: {
			resume: async (opts: Record<string, unknown>) => {
				if (options.resumeError !== undefined) {
					throw options.resumeError;
				}
				// The resumed session's header carries the session cwd; the
				// factory must take the run workspace from it, not the request.
				const session = {
					id: opts.resumeSessionId,
					header: { cwd: options.headerCwd },
					events: [],
				};
				const agent = {
					id: session.id,
					options: { provider: "openrouter" },
					session,
					whenIdle: vi.fn(() => {
						orchestratorCalls.whenIdle += 1;
						return Promise.resolve(undefined);
					}),
					cancel: vi.fn(() => {
						orchestratorCalls.cancel += 1;
					}),
					followup: vi.fn(() => {
						orchestratorCalls.followup += 1;
					}),
					ctx: {},
				};
				const handle: AgentHandle = {
					agent: agent as never,
					dispose: vi.fn().mockResolvedValue(undefined),
				};
				resumed.push({ handle, opts });
				return handle;
			},
		},
		subagents: {
			start: async (_name: string, request: Record<string, unknown>) => {
				const { promise, resolve } = deferred<SubagentResult>();
				const run: SubagentRun = {
					id: `spawn-${spawnSeq++}` as never,
					localAgent: undefined,
					result: promise,
					dispose: vi.fn().mockResolvedValue(undefined),
				};
				spawned.push({
					run,
					request,
					settle: resolve,
					signal: request.signal as AbortSignal,
				});
				return run;
			},
		},
		on: (_name: string, listener: FakeHarness["sessionListeners"][0]) => {
			sessionListeners.push(listener);
			return () => true;
		},
	};

	return {
		ctx: context as unknown as Context,
		models,
		resumed,
		spawned,
		sessionListeners,
		orchestratorCalls,
		headerCwd: options.headerCwd,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await delay(5);
	}
}

/** Start one run through the real factory and collect its event stream. */
function startRun(
	harness: FakeHarness,
	request: RunRequest = baseRequest(),
): { events: RunEvent[]; handle: ReturnType<StartRun> } {
	const events: RunEvent[] = [];
	const stop = createRunFactory(harness.ctx);
	const handle = stop(request, (event) => events.push(event));
	return { events, handle };
}

describe("real run factory", () => {
	it("resumes the requested session on the primary model and spawns two concurrent read-only workers", async () => {
		const harness = makeHarness(undefined, { headerCwd: WORKSPACE });
		const { events } = startRun(harness);
		expect(events[0]).toEqual({
			type: "run/started",
			runId: expect.any(String),
		});

		await waitUntil(() => harness.resumed.length === 1);
		await waitUntil(() => harness.spawned.length === 2);

		const resumeOpts = harness.resumed[0]?.opts as {
			resumeSessionId: string;
			agentOptions: { provider: string; model: string };
		};
		// The run resumes the requested session (its saved context loads, so
		// new turns append to that same session) on the primary model.
		expect(resumeOpts.resumeSessionId).toBe(SESSION_ID);
		expect(resumeOpts.agentOptions.provider).toBe("openrouter");
		expect(resumeOpts.agentOptions.model).toBe(baseRequest().primaryModel);
		// The run workspace is the resumed session's header cwd (the request
		// carries no workspace field): the fake's header cwd is a valid folder,
		// so the run proceeds; the derivation is pinned behaviorally by the
		// invalid-header-cwd failure test below.
		expect(harness.headerCwd).toBe(WORKSPACE);
		expect(resolveWorkspace(WORKSPACE)).toBe(realpathSync(WORKSPACE));

		const calls = harness.spawned;
		const toolFilters = calls.map(
			(call) => (call.request as { toolFilter: unknown }).toolFilter,
		);
		// Every spawned worker is restricted to the read-only tools (ADR-0001).
		for (const filter of toolFilters) {
			expect(filter).toEqual({ allow: WORKER_TOOLS });
		}

		const models = calls.map(
			(call) =>
				(call.request as { agentOptions: { model: string } }).agentOptions
					.model,
		);
		expect(models.sort()).toEqual(
			[baseRequest().laneModels.left, baseRequest().laneModels.right].sort(),
		);
		expect(events.some((e) => e.type === "orchestrator/delta")).toBe(true);
	});

	it("rejects an empty or whitespace-only workspace (no implicit folder)", async () => {
		// The resolver must not silently fall back to the server working
		// directory (parent #9: an empty workspace is invalid).
		expect(resolveWorkspace("")).toBeUndefined();
		expect(resolveWorkspace("   ")).toBeUndefined();
	});

	it("a resumed session whose header has no valid cwd fails both lanes before any worker spawns", async () => {
		// The run's workspace is the resumed session's cwd from its header; a
		// session whose folder is gone (or never had one) must fail fast before
		// any worker spawns, exactly as an invalid workspace did (parent #9/#40).
		const harness = makeHarness(undefined, {
			headerCwd: join(tmpdir(), "definitely-not-a-folder-xyz"),
		});
		const { events } = startRun(harness);

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		const errors = events.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(2);
		expect(harness.resumed.length).toBe(1);
		expect(harness.spawned.length).toBe(0);
		expect(events.some((e) => e.type === "lane/worker/started")).toBe(false);
		expect(
			events.some((e) => (e as { type: string }).type === "run/summary"),
		).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});
	});

	it("an unresumable session id fails both lanes and ends the run before any worker spawns", async () => {
		// The production factory resumes the requested session; a session the
		// harness cannot load rejects, so both lanes error and the run ends
		// with nothing started (no orchestrator, no workers, no summary).
		const harness = makeHarness(undefined, {
			resumeError: new Error("session not found"),
		});
		const { events } = startRun(harness);

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		const errors = events.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(2);
		expect(harness.resumed.length).toBe(0);
		expect(harness.spawned.length).toBe(0);
		expect(events.some((e) => e.type === "lane/worker/started")).toBe(false);
		expect(
			events.some((e) => (e as { type: string }).type === "run/summary"),
		).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});
	});

	it("routes worker session text deltas to the owning lane", async () => {
		const harness = makeHarness(undefined, { headerCwd: WORKSPACE });
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		const left = harness.spawned[0] as SpawnedRun;
		const right = harness.spawned[1] as SpawnedRun;
		// The factory watches by the child session id.
		for (const listener of harness.sessionListeners) {
			listener(
				{ id: left.run.id },
				{
					type: "assistant/chunk",
					data: { chunk: { type: "text-delta", text: "the " } },
				},
			);
			listener(
				{ id: right.run.id },
				{
					type: "assistant/chunk",
					data: { chunk: { type: "text-delta", text: "sea" } },
				},
			);
		}

		await waitUntil(() =>
			events.some(
				(e) => e.type === "lane/worker/delta" && e.laneId === "right",
			),
		);
		const leftDelta = events.find(
			(e) => e.type === "lane/worker/delta" && e.laneId === "left",
		);
		expect(leftDelta).toEqual({
			type: "lane/worker/delta",
			laneId: "left",
			text: "the ",
		});
		const rightDelta = events.find(
			(e) => e.type === "lane/worker/delta" && e.laneId === "right",
		);
		expect(rightDelta).toEqual({
			type: "lane/worker/delta",
			laneId: "right",
			text: "sea",
		});
	});

	it("emits lane/worker/done for both and run/done (no run/summary) when both workers complete", async () => {
		const harness = makeHarness(undefined, { headerCwd: WORKSPACE });
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		harness.spawned[0]?.settle({
			output: [{ type: "text", text: "quiet" }],
			stopReason: "completed",
		});
		harness.spawned[1]?.settle({
			output: [{ type: "text", text: "bright" }],
			stopReason: "completed",
		});

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		const leftDone = events.find(
			(e) => e.type === "lane/worker/done" && e.laneId === "left",
		);
		const rightDone = events.find(
			(e) => e.type === "lane/worker/done" && e.laneId === "right",
		);
		expect(leftDone).toEqual({ type: "lane/worker/done", laneId: "left" });
		expect(rightDone).toEqual({ type: "lane/worker/done", laneId: "right" });

		// No run/summary: the run ends with run/done as soon as both lanes settle.
		expect(
			events.some((e) => (e as { type: string }).type === "run/summary"),
		).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});

		// The orchestrator is never invoked (no summary; model selection retained).
		expect(harness.orchestratorCalls.followup).toBe(0);
		expect(harness.orchestratorCalls.whenIdle).toBe(0);
	});

	it("a failed worker errors its own lane without killing the other lane or the run", async () => {
		const harness = makeHarness(undefined, { headerCwd: WORKSPACE });
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		harness.spawned[0]?.settle({ output: [], stopReason: "completed" });
		harness.spawned[1]?.settle({ output: [], stopReason: "error" });

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		const rightError = events.find(
			(e) => e.type === "lane/worker/error" && e.laneId === "right",
		);
		expect((rightError as { reason?: string } | undefined)?.reason).toBe(
			"error",
		);
		expect(
			events.some((e) => e.type === "lane/worker/done" && e.laneId === "left"),
		).toBe(true);
		expect(
			events.some((e) => (e as { type: string }).type === "run/summary"),
		).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});
	});

	it("cancel aborts the resumed orchestrator and both workers and emits run/canceled", async () => {
		const harness = makeHarness(undefined, { headerCwd: WORKSPACE });
		const { events, handle } = startRun(harness);
		await waitUntil(() => harness.resumed.length === 1);
		await waitUntil(() => harness.spawned.length === 2);

		handle.cancel();

		await waitUntil(() => events.some((e) => e.type === "run/canceled"));

		const orchestrator = harness.resumed[0]?.handle.agent as unknown as {
			cancel: ReturnType<typeof vi.fn>;
		};
		expect(orchestrator.cancel).toHaveBeenCalledWith({ kind: "user" });
		for (const call of harness.spawned) {
			expect(call.signal.aborted).toBe(true);
		}
		expect(events.some((e) => e.type === "run/done")).toBe(false);
	});

	it("a bad lane model id errors only its lane while the other lane keeps running", async () => {
		// Only the left lane model is configured; the right lane id is
		// unresolvable. The right lane must error on its own while the left
		// lane still runs and the run reaches done (parent story 20).
		const harness = makeHarness([MODELS[0] as (typeof MODELS)[number]], {
			headerCwd: WORKSPACE,
		});
		const request: RunRequest = baseRequest({
			laneModels: {
				left: "deepseek/deepseek-v4-flash-0731",
				right: "no-such/model",
			},
		});
		const { events } = startRun(harness, request);

		// The right lane errors on its own; the left lane still spawns.
		await waitUntil(() => harness.spawned.length === 1);
		expect(
			events.some(
				(e) => e.type === "lane/worker/error" && e.laneId === "right",
			),
		).toBe(true);

		// Settle the left worker so the run reaches done.
		harness.spawned[0]?.settle({ output: [], stopReason: "completed" });

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		// The left lane still ran and completed.
		expect(
			events.some((e) => e.type === "lane/worker/done" && e.laneId === "left"),
		).toBe(true);
		// Only the right lane errored; the run still reached done.
		const errors = events.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(1);
		expect(
			events.some((e) => (e as { type: string }).type === "run/summary"),
		).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});
	});

	it("an unresolvable primary model errors both lanes and still ends the run", async () => {
		const harness = makeHarness([]);
		const { events } = startRun(harness);

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		const errors = events.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(2);
		expect(events.some((e) => e.type === "run/started")).toBe(true);
	});
});
