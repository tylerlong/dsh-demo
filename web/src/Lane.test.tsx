// @vitest-environment jsdom
/**
 * Lane.test.tsx — component tests for the lane component (ticket #33, parent #37).
 *
 * The lane renders one side of the comparison: its heading and the worker's
 * status chip (idle / running · Ns / done · Ns / error · Ns / canceled · Ns).
 * The run lifecycle hook owns the lane state; these tests pin the rendering
 * the user sees — chip text per status — never component internals. The lane
 * worker's output panel is gone (parent #37): output is read from the store
 * in the transcript panel, not streamed here.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Lane, type LaneProps, laneChipText } from "./Lane.tsx";

function renderLane(overrides: Partial<LaneProps> = {}) {
	return render(
		<Lane
			laneId="left"
			heading="Left lane"
			status="idle"
			elapsed={0}
			{...overrides}
		/>,
	);
}

describe("Lane", () => {
	it("renders the heading; an idle lane shows no chip", () => {
		renderLane();
		expect(
			screen.getByRole("heading", { name: "Left lane" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent("");
	});

	it("shows the running chip with elapsed seconds", () => {
		renderLane({ status: "running", elapsed: 3 });
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent(
			"running · 3s",
		);
	});

	it("shows each terminal chip with its elapsed seconds", () => {
		const { rerender } = renderLane({ status: "done", elapsed: 5 });
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent(
			"done · 5s",
		);

		rerender(
			<Lane laneId="left" heading="Left lane" status="error" elapsed={2} />,
		);
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent(
			"error · 2s",
		);

		rerender(
			<Lane laneId="left" heading="Left lane" status="canceled" elapsed={4} />,
		);
		expect(screen.getByTestId("lane-left-status")).toHaveTextContent(
			"canceled · 4s",
		);
	});

	it("formats the chip text", () => {
		expect(laneChipText("idle", 0)).toBe("");
		expect(laneChipText("running", 1)).toBe("running · 1s");
		expect(laneChipText("done", 9)).toBe("done · 9s");
		expect(laneChipText("error", 2)).toBe("error · 2s");
		expect(laneChipText("canceled", 4)).toBe("canceled · 4s");
	});
});
