/**
 * real-run-factory.test.ts — tests for the harness-backed run factory (#5).
 *
 * The factory is a thin composition of harness primitives (agents.create,
 * subagents.start, session event watching, cancellation). These tests drive it
 * against a fake harness context — a fake llm registry, agent factory, and
 * subagent provider — so no real model call or harness boot is involved. They
 * pin the orchestration shape (orchestrator on the primary model, two
 * read-only workers on the lane models), the event translation (session text
 * deltas → lane/worker/delta, completion → lane/worker/done,
 * summary → run/summary, cancel → run/canceled), and the read-only tool
 * filter.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SubagentResult, SubagentRun } from "@deepseek-ai/dsh-subagent";
import { describe, expect, it, vi } from "vitest";
import { createRunFactory, WORKER_TOOLS } from "../src/real-run-factory.ts";
import type { RunEvent, RunRequest, StartRun } from "../src/run-factory.ts";

const MODELS = [
	{
		provider: "openrouter",
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
	},
	{ provider: "openrouter", id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna" },
];

const REQUEST: RunRequest = {
	task: "Compare the sea and the sky",
	primaryModel: "deepseek/deepseek-v4-flash-0731",
	laneModels: {
		left: "deepseek/deepseek-v4-flash-0731",
		right: "openai/gpt-5.6-luna",
	},
};

/** A promise the test resolves to settle a spawned run's result. */
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

interface CreatedAgent {
	readonly handle: AgentHandle;
	readonly opts: Record<string, unknown>;
}

interface FakeHarness {
	ctx: Context;
	models: typeof MODELS;
	created: CreatedAgent[];
	spawned: SpawnedRun[];
	sessionListeners: Array<(session: { id: string }, event: unknown) => void>;
	// The orchestrator agent's session events (the factory reads the summary).
	orchestratorEvents: Array<Record<string, unknown>>;
	followups: string[];
}

/** Build a fake harness context the factory can drive. */
function makeHarness(models: typeof MODELS = MODELS): FakeHarness {
	const created: CreatedAgent[] = [];
	const spawned: SpawnedRun[] = [];
	const sessionListeners: FakeHarness["sessionListeners"] = [];
	let orchestratorEvents: Array<Record<string, unknown>> = [];
	const followups: string[] = [];

	let spawnSeq = 0;
	const context = {
		llm: {
			listProviders: () => [{ id: "openrouter" }],
			listModels: () => Promise.resolve(models),
		},
		agents: {
			create: async (opts: Record<string, unknown>) => {
				const session = {
					id: "session-orchestrator",
					// Live view: the test replaces the array to stage the summary.
					get events() {
						return orchestratorEvents;
					},
				};
				const agent = {
					id: session.id,
					options: { provider: "openrouter" },
					session,
					whenIdle: vi.fn().mockResolvedValue(undefined),
					cancel: vi.fn(),
					followup: vi.fn((message: { content?: Array<{ text?: string }> }) => {
						const text = message.content?.[0]?.text ?? "";
						followups.push(text);
					}),
					ctx: {},
				};
				const handle: AgentHandle = {
					agent: agent as never,
					dispose: vi.fn().mockResolvedValue(undefined),
				};
				created.push({ handle, opts });
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
		created,
		spawned,
		sessionListeners,
		get orchestratorEvents() {
			return orchestratorEvents;
		},
		set orchestratorEvents(value) {
			orchestratorEvents = value;
		},
		followups,
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
	request: RunRequest = REQUEST,
): { events: RunEvent[]; handle: ReturnType<StartRun> } {
	const events: RunEvent[] = [];
	const stop = createRunFactory(harness.ctx);
	const handle = stop(request, (event) => events.push(event));
	return { events, handle };
}

describe("real run factory", () => {
	it("creates the orchestrator on the primary model and spawns two concurrent read-only workers", async () => {
		const harness = makeHarness();
		const { events } = startRun(harness);
		expect(events[0]).toEqual({
			type: "run/started",
			runId: expect.any(String),
		});

		await waitUntil(() => harness.created.length === 1);
		await waitUntil(() => harness.spawned.length === 2);

		const createOpts = harness.created[0]?.opts as {
			agentOptions: { provider: string; model: string };
		};
		expect(createOpts.agentOptions.provider).toBe("openrouter");
		expect(createOpts.agentOptions.model).toBe(REQUEST.primaryModel);

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
			[REQUEST.laneModels.left, REQUEST.laneModels.right].sort(),
		);
		expect(events.some((e) => e.type === "orchestrator/delta")).toBe(true);
	});

	it("routes worker session text deltas to the owning lane", async () => {
		const harness = makeHarness();
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		const left = harness.spawned[0] as SpawnedRun;
		const right = harness.spawned[1] as SpawnedRun;
		// The factory watches by the child's session id.
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

	it("emits lane/worker/done for both, a run/summary, and run/done when both workers complete", async () => {
		const harness = makeHarness();
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		harness.orchestratorEvents = [
			{
				type: "assistant/message",
				data: {
					message: { content: [{ type: "text", text: "The sea wins." }] },
				},
			},
		];

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

		const summary = events.find((e) => e.type === "run/summary");
		expect(summary).toEqual({ type: "run/summary", summary: "The sea wins." });
		expect(events.at(-1)).toEqual({
			type: "run/done",
			runId: expect.any(String),
		});

		// The orchestrator summary prompt quoted both workers' answers.
		expect(harness.followups.join("\n")).toContain("quiet");
		expect(harness.followups.join("\n")).toContain("bright");
	});

	it("a failed worker errors its own lane without killing the other lane or the run", async () => {
		const harness = makeHarness();
		const { events } = startRun(harness);
		await waitUntil(() => harness.spawned.length === 2);

		harness.orchestratorEvents = [
			{
				type: "assistant/message",
				data: { message: { content: [{ type: "text", text: "summary" }] } },
			},
		];

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
		expect(events.some((e) => e.type === "run/summary")).toBe(true);
	});

	it("cancel aborts the orchestrator and both workers and emits run/canceled", async () => {
		const harness = makeHarness();
		const { events, handle } = startRun(harness);
		await waitUntil(() => harness.created.length === 1);
		await waitUntil(() => harness.spawned.length === 2);

		handle.cancel();

		await waitUntil(() => events.some((e) => e.type === "run/canceled"));

		const orchestrator = harness.created[0]?.handle.agent as unknown as {
			cancel: ReturnType<typeof vi.fn>;
		};
		expect(orchestrator.cancel).toHaveBeenCalledWith({ kind: "user" });
		for (const call of harness.spawned) {
			expect(call.signal.aborted).toBe(true);
		}
		expect(events.some((e) => e.type === "run/done")).toBe(false);
	});

	it("a bad lane model id errors only its lane while the other lane keeps running", async () => {
		// Only the left lane's model is configured; the right lane's id is
		// unresolvable. The right lane must error on its own while the left
		// lane still runs and the run reaches a summary + done (parent story 20).
		const harness = makeHarness([MODELS[0] as (typeof MODELS)[number]]);
		const request: RunRequest = {
			...REQUEST,
			laneModels: {
				left: "deepseek/deepseek-v4-flash-0731",
				right: "no-such/model",
			},
		};
		const { events } = startRun(harness, request);

		// The right lane errors on its own; the left lane still spawns.
		await waitUntil(() => harness.spawned.length === 1);
		expect(
			events.some(
				(e) => e.type === "lane/worker/error" && e.laneId === "right",
			),
		).toBe(true);

		// Settle the left worker so the run reaches a summary + done.
		harness.orchestratorEvents = [
			{
				type: "assistant/message",
				data: { message: { content: [{ type: "text", text: "summary" }] } },
			},
		];
		harness.spawned[0]?.settle({ output: [], stopReason: "completed" });

		await waitUntil(() => events.some((e) => e.type === "run/done"));

		// The left lane still ran and completed.
		expect(
			events.some((e) => e.type === "lane/worker/done" && e.laneId === "left"),
		).toBe(true);
		// Only the right lane errored; the run still produced a summary + done.
		const errors = events.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(1);
		expect(events.some((e) => e.type === "run/summary")).toBe(true);
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
