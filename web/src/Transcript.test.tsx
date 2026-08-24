// @vitest-environment jsdom
/**
 * Transcript.test.tsx — component tests for the styled transcript
 * (parent ticket #37, child ticket #47).
 *
 * The right panel renders the selected session's primary-only transcript with
 * two background styles: model input (user-role) vs model output
 * (assistant-role); every other line (tool/step/system) keeps the default
 * panel style — there is no third background. The live lane-worker windows of
 * our own in-progress run are supplied on the read and rendered alongside the
 * primary.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionTranscript } from "./api.ts";
import { Transcript } from "./Transcript.tsx";

const TRANSCRIPT: SessionTranscript = {
	primary: {
		sessionId: "session-1",
		lines: [
			{ text: "user question", role: "input" },
			{ text: "model answer", role: "output" },
			{ text: "tool step line", role: "default" },
		],
	},
	lanes: [
		{
			sessionId: "session-1-left",
			lines: [
				{ text: "user left", role: "input" },
				{ text: "left lane answer", role: "output" },
			],
		},
	],
};

function renderTranscript(transcript: SessionTranscript | undefined = TRANSCRIPT) {
	return render(
		<Transcript
			sessionId="session-1"
			transcript={transcript}
			loading={false}
		/>,
	);
}

describe("Transcript", () => {
	it("styles input and output lines with distinct backgrounds; default stays plain", () => {
		renderTranscript();

		const primary = screen.getByTestId("transcript-primary");

		const input = Array.from(primary.querySelectorAll("div")).find((node) =>
			node.textContent?.includes("user question"),
		);
		const output = Array.from(primary.querySelectorAll("div")).find((node) =>
			node.textContent?.includes("model answer"),
		);
		const tool = Array.from(primary.querySelectorAll("div")).find((node) =>
			node.textContent?.includes("tool step line"),
		);

		expect(input).toBeDefined();
		expect(output).toBeDefined();
		expect(tool).toBeDefined();
		// Input and output carry distinct background classes.
		expect(input?.className).toContain("bg-sky-100");
		expect(output?.className).not.toContain("bg-sky-100");
		expect(output?.className).toContain("bg-emerald-50");
		// The default line has no input/output background.
		expect(tool?.className).not.toContain("bg-sky-100");
		expect(tool?.className).not.toContain("bg-emerald-50");
	});

	it("renders the live lane windows alongside the primary", () => {
		renderTranscript();

		const workers = screen.getAllByTestId("transcript-worker");
		expect(workers).toHaveLength(1);
		expect(workers[0]).toHaveTextContent("left lane answer");
	});

	it("renders no lane windows when there is no live run", () => {
		renderTranscript({
			primary: {
				sessionId: "session-1",
				lines: [{ text: "only primary", role: "output" }],
			},
			lanes: [],
		});
		expect(screen.queryAllByTestId("transcript-worker")).toHaveLength(0);
		expect(screen.getByTestId("transcript-primary")).toHaveTextContent(
			"only primary",
		);
	});

	it("renders the submitted task as an input line and the streamed lane answers as output, kept after the run", () => {
		render(
			<Transcript
				sessionId="session-1"
				transcript={{ primary: { sessionId: "session-1", lines: [] }, lanes: [] }}
				loading={false}
				runStart={{ sessionId: "session-1", task: "what is your ai model?" }}
				laneTexts={{ left: "left answer", right: "right answer" }}
			/>,
		);
		// The task shows as the primary's input line.
		const primary = screen.getByTestId("transcript-primary");
		expect(primary).toHaveTextContent("what is your ai model?");
		// The streamed lane answers render as the two lane windows.
		const workers = screen.getAllByTestId("transcript-worker");
		expect(workers).toHaveLength(2);
		expect(workers[0]?.textContent ?? "").toContain("left answer");
		expect(workers[1]?.textContent ?? "").toContain("right answer");
	});

	it("never shows one run's content under another session's transcript", () => {
		render(
			<Transcript
				sessionId="session-2"
				transcript={{ primary: { sessionId: "session-2", lines: [] }, lanes: [] }}
				loading={false}
				// The run belongs to session-1; session-2 is selected.
				runStart={{ sessionId: "session-1", task: "what is your ai model?" }}
				laneTexts={{ left: "left answer", right: "right answer" }}
			/>,
		);
		// No task line, no streamed lane windows.
		expect(screen.getByTestId("transcript-primary")).not.toHaveTextContent(
			"what is your ai model?",
		);
		expect(screen.queryAllByTestId("transcript-worker")).toHaveLength(0);
	});

	it("renders the pre-selection invite and the empty transcript hint", () => {
		const { unmount } = render(
			<Transcript sessionId={undefined} transcript={undefined} loading={false} />,
		);
		expect(
			screen.getByText(/Select a session to view its transcript/),
		).toBeInTheDocument();
		unmount();
		render(<Transcript sessionId="s" transcript={undefined} loading={false} />);
		expect(screen.getByText(/No transcript available/)).toBeInTheDocument();
	});

	it("shows the loading placeholder while a read is in flight", () => {
		render(
			<Transcript sessionId="s" transcript={undefined} loading={true} />,
		);
		expect(screen.getByText(/Loading transcript/)).toBeInTheDocument();
	});
});
