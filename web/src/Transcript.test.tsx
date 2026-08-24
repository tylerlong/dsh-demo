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
import { describe, expect, it, vi } from "vitest";
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
	moreBefore: false,
};

function renderTranscript(
	transcript: SessionTranscript | undefined = TRANSCRIPT,
) {
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
		// Input and output carry distinct background classes: user input is
		// green, model output is blue.
		expect(input?.className).toContain("bg-emerald-50");
		expect(input?.className).not.toContain("bg-sky-100");
		expect(output?.className).toContain("bg-sky-100");
		expect(output?.className).not.toContain("bg-emerald-50");
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
			moreBefore: false,
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
				transcript={{
					primary: { sessionId: "session-1", lines: [] },
					lanes: [],
					moreBefore: false,
				}}
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

	it("on the run session, streamed lanes always replace the store-read lanes (no injected context)", () => {
		render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: { sessionId: "session-1", lines: [] },
					// The store read of the child session is dominated by the
					// injected workspace context — it must never render.
					lanes: [
						{
							sessionId: "session-1-child",
							lines: [
								{ text: "CONTEXT.md", role: "input" },
								{ text: "Agent skills", role: "input" },
							],
						},
					],
					moreBefore: false,
				}}
				loading={false}
				runStart={{ sessionId: "session-1", task: "question" }}
				laneTexts={{ left: "left answer", right: "right answer" }}
			/>,
		);
		const workers = screen.getAllByTestId("transcript-worker");
		expect(workers).toHaveLength(2);
		expect(workers[0]?.textContent ?? "").toContain("left answer");
		expect(screen.queryByText("CONTEXT.md")).not.toBeInTheDocument();
		expect(screen.queryByText("Agent skills")).not.toBeInTheDocument();
	});

	it("keeps the run's question and answers visible while the store read is loading or failed", () => {
		// Loading: the run content still renders.
		const { unmount } = render(
			<Transcript
				sessionId="session-1"
				transcript={undefined}
				loading={true}
				runStart={{ sessionId: "session-1", task: "question" }}
				laneTexts={{ left: "left answer" }}
			/>,
		);
		expect(screen.getByTestId("transcript-primary")).toHaveTextContent(
			"question",
		);
		expect(screen.getByTestId("transcript-worker")).toHaveTextContent(
			"left answer",
		);
		unmount();

		// Failed read (transcript undefined): the run content still renders.
		render(
			<Transcript
				sessionId="session-1"
				transcript={undefined}
				loading={false}
				runStart={{ sessionId: "session-1", task: "question" }}
				laneTexts={{ left: "left answer" }}
			/>,
		);
		expect(screen.getByTestId("transcript-primary")).toHaveTextContent(
			"question",
		);
		expect(screen.getByTestId("transcript-worker")).toHaveTextContent(
			"left answer",
		);
	});

	it("never shows one run's content under another session's transcript", () => {
		render(
			<Transcript
				sessionId="session-2"
				transcript={{
					primary: { sessionId: "session-2", lines: [] },
					lanes: [],
					moreBefore: false,
				}}
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
			<Transcript
				sessionId={undefined}
				transcript={undefined}
				loading={false}
			/>,
		);
		expect(
			screen.getByText(/Select a session to view its transcript/),
		).toBeInTheDocument();
		unmount();
		render(<Transcript sessionId="s" transcript={undefined} loading={false} />);
		expect(screen.getByText(/No transcript available/)).toBeInTheDocument();
	});

	it("shows the loading placeholder while a read is in flight", () => {
		render(<Transcript sessionId="s" transcript={undefined} loading={true} />);
		expect(screen.getByText(/Loading transcript/)).toBeInTheDocument();
	});

	it("shows the Load more button at the top only while moreBefore is true", () => {
		const onLoadMore = vi.fn();
		const { unmount } = render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "newest", role: "output" }],
					},
					lanes: [],
					moreBefore: true,
				}}
				loading={false}
				onLoadMore={onLoadMore}
			/>,
		);

		// The button renders above the primary window (the panel header is the
		// only element above it).
		const button = screen.getByTestId("transcript-load-more");
		expect(button).toHaveTextContent("Load more");
		const header = screen.getByRole("heading", { name: "Transcript" });
		const primary = screen.getByTestId("transcript-primary");
		expect(
			button.compareDocumentPosition(primary) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			header.compareDocumentPosition(button) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Clicking grows the window via the callback.
		button.click();
		expect(onLoadMore).toHaveBeenCalledTimes(1);
		unmount();

		// No more history before the window: the button is gone.
		render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "only", role: "output" }],
					},
					lanes: [],
					moreBefore: false,
				}}
				loading={false}
				onLoadMore={onLoadMore}
			/>,
		);
		expect(
			screen.queryByTestId("transcript-load-more"),
		).not.toBeInTheDocument();
	});

	it("hides the Load more button when the page cannot grow the window", () => {
		render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "more", role: "output" }],
					},
					lanes: [],
					moreBefore: true,
				}}
				loading={false}
				// No onLoadMore: the button must not appear (nothing would happen).
			/>,
		);
		expect(
			screen.queryByTestId("transcript-load-more"),
		).not.toBeInTheDocument();
	});
});
