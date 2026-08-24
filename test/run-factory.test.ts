/**
 * run-factory.test.ts — seam-level tests for the run-factory seam.
 *
 * These tests exercise the agreed test seam (the injected run factory) at its
 * public boundary: a scripted fake factory that emits events without any real
 * LLM call. The tests drive the fake exactly as the server (ticket #3) will
 * drive production injected startRun, so they pin the contract #3 builds on.
 *
 * New contract (parent ticket #37/#40): a run carries a sessionId (the
 * persisted session to resume), ends with run/done as soon as both lanes
 * settle, never emits run/summary, and an empty session id fails
 * immediately with both lanes erroring + run/done.
 */
import { describe, expect, it } from "vitest";
import { createScriptedRunFactory } from "../src/run-factory.ts";

const baseRequest = () => ({
	task: "Compare two models on a haiku",
	primaryModel: "deepseek/deepseek-v4-flash-0731",
	laneModels: {
		left: "deepseek/deepseek-v4-flash-0731",
		right: "openai/gpt-5.6-luna",
	},
	sessionId: "session-seam-test",
});

/** Grab the latest run or fail the test; the factory always has one here. */
function lastRun(factory: ReturnType<typeof createScriptedRunFactory>) {
	const run = factory.lastRun;
	expect(run).toBeDefined();
	if (run === undefined) throw new Error("expected a started run");
	return run;
}

describe("run-factory seam", () => {
	it("produces a run handle with a stable id and cancel()", () => {
		const factory = createScriptedRunFactory();
		const events: Array<unknown> = [];
		const handle = factory.startRun(baseRequest(), (event) =>
			events.push(event),
		);

		expect(typeof handle.id).toBe("string");
		expect(handle.id).toBe("0");
		expect(typeof handle.cancel).toBe("function");
		expect(factory.lastRun).toBeDefined();
		expect(events).toEqual([{ type: "run/started", runId: "0" }]);
	});

	it("routes worker output to the owning lane and orchestrator text to the top", () => {
		const factory = createScriptedRunFactory();
		const received: Array<{ event: string; laneId?: string }> = [];
		const onEvent = (event: { type: string; laneId?: string }) => {
			received.push({ event: event.type, laneId: event.laneId });
		};
		factory.startRun(baseRequest(), onEvent);
		const run = lastRun(factory);
		run.emit({ type: "lane/worker/delta", laneId: "left", text: "hi" });
		run.emit({ type: "orchestrator/delta", text: "spawning" });
		run.emit({ type: "lane/worker/done", laneId: "right" });

		expect(received.map((r) => r.event)).toEqual([
			"run/started",
			"lane/worker/delta",
			"orchestrator/delta",
			"lane/worker/done",
		]);
		expect(received[1]).toEqual({ event: "lane/worker/delta", laneId: "left" });
		expect(received[2]).toEqual({
			event: "orchestrator/delta",
			laneId: undefined,
		});
		expect(received[3]).toEqual({ event: "lane/worker/done", laneId: "right" });
	});

	it("marks a run canceled through its handle without emitting", () => {
		const factory = createScriptedRunFactory();
		const handle = factory.startRun(baseRequest(), () => {});
		const run = lastRun(factory);
		expect(run.canceled).toBe(false);
		handle.cancel();
		expect(run.canceled).toBe(true);
	});

	it("tracks every started run in start order", () => {
		const factory = createScriptedRunFactory();
		factory.startRun({ ...baseRequest(), task: "t1" }, () => {});
		factory.startRun({ ...baseRequest(), task: "t2" }, () => {});
		expect(factory.runs.map((r) => r.request.task)).toEqual(["t1", "t2"]);
		expect(factory.runs[1]?.handle.id).toBe("1");
	});

	it("carries the session id in the request", () => {
		const factory = createScriptedRunFactory();
		factory.startRun(
			{ ...baseRequest(), sessionId: "session-other" },
			() => {},
		);
		expect(factory.lastRun?.request.sessionId).toBe("session-other");
	});

	it("emits run/done as soon as both lanes settle and never a run/summary", () => {
		const factory = createScriptedRunFactory();
		const received: Array<{ type: string }> = [];
		factory.startRun(baseRequest(), (event) => received.push(event));
		const run = lastRun(factory);
		run.emit({ type: "lane/worker/done", laneId: "left" });
		run.emit({ type: "lane/worker/done", laneId: "right" });

		// run/done arrives right after the second lane settles; never run/summary.
		expect(received.map((e) => e.type)).toEqual([
			"run/started",
			"lane/worker/done",
			"lane/worker/done",
			"run/done",
		]);
		expect(received.some((e) => e.type === "run/summary")).toBe(false);
	});

	it("a lane error still settles that lane toward run/done", () => {
		const factory = createScriptedRunFactory();
		const received: Array<{ type: string }> = [];
		factory.startRun(baseRequest(), (event) => received.push(event));
		const run = lastRun(factory);
		run.emit({ type: "lane/worker/error", laneId: "left", reason: "x" });
		run.emit({ type: "lane/worker/done", laneId: "right" });

		expect(received.map((e) => e.type)).toEqual([
			"run/started",
			"lane/worker/error",
			"lane/worker/done",
			"run/done",
		]);
	});

	it("an empty session id fails immediately: both lanes error and the run ends before any worker starts", () => {
		const factory = createScriptedRunFactory();
		const received: Array<{ type: string; laneId?: string; reason?: string }> =
			[];
		const handle = factory.startRun(
			{
				...baseRequest(),
				sessionId: "   ",
			},
			(event) => received.push(event),
		);

		// The run still has a handle, but both lanes errored and run/done ended it.
		expect(typeof handle.id).toBe("string");
		const types = received.map((e) => e.type);
		expect(types).toContain("lane/worker/error");
		expect(types).toContain("run/done");
		// No worker ever started: no lane/worker/started and no run/summary.
		expect(types).not.toContain("lane/worker/started");
		expect(types).not.toContain("run/summary");
		const errors = received.filter((e) => e.type === "lane/worker/error");
		expect(errors.length).toBe(2);
	});
});
