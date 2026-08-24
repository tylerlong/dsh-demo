import { describe, expect, it } from "vitest";
import { liveLanesFor, registerLiveLanes } from "../src/live-lanes.ts";

describe("live-lanes registry", () => {
	it("registers and unregisters lane refs", () => {
		const un = registerLiveLanes("s-1", [
			{ laneId: "left", workerSessionId: "w-l" },
		]);
		expect(liveLanesFor("s-1")).toEqual([
			{ laneId: "left", workerSessionId: "w-l" },
		]);
		un();
		expect(liveLanesFor("s-1")).toEqual([]);
	});
	it("merges two lanes for one session", () => {
		const u1 = registerLiveLanes("s-2", [
			{ laneId: "left", workerSessionId: "wl" },
		]);
		const u2 = registerLiveLanes("s-2", [
			{ laneId: "right", workerSessionId: "wr" },
		]);
		expect(
			liveLanesFor("s-2")
				.map((r) => r.laneId)
				.sort(),
		).toEqual(["left", "right"]);
		u1();
		u2();
		expect(liveLanesFor("s-2")).toEqual([]);
	});
});
