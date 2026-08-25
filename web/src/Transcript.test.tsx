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
	currentPair: 1,
	pairCount: 1,
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
	it("styles prompt and response with plain text and separates them, default stays dim", () => {
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
		// Neither prompt nor response carries a background tint anymore.
		expect(input?.className).not.toContain("bg-emerald-50");
		expect(input?.className).not.toContain("bg-sky-100");
		expect(output?.className).not.toContain("bg-emerald-50");
		expect(output?.className).not.toContain("bg-sky-100");
		// The default/tool line is dimmed but also plain.
		expect(tool?.className).not.toContain("bg-emerald-50");
		expect(tool?.className).not.toContain("bg-sky-100");
		// A separator splits the prompt block from the response block.
		expect(primary.querySelector('[data-testid="transcript-separator"]')).toBeTruthy();
	});

	it("places the separator exactly between the last prompt line and the first response line, with blank lines around it", () => {
		renderTranscript({
			primary: {
				sessionId: "session-1",
				lines: [
					{ text: "prompt line a", role: "input" },
					{ text: "prompt line b", role: "input" },
					{ text: "response line", role: "output" },
				],
			},
			lanes: [],
			currentPair: 1,
			pairCount: 1,
		});

		const primary = screen.getByTestId("transcript-primary");
		const separators = primary.querySelectorAll(
			'[data-testid="transcript-separator"]',
		);
		expect(separators).toHaveLength(1);
		const separator = separators[0]!;
		// A blank spacer element sits before and after the separator, which in
		// turn sits between the last prompt line and the first response line.
		expect(separator.previousElementSibling?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		expect(
			separator.previousElementSibling?.previousElementSibling?.textContent,
		).toContain("prompt line b");
		expect(separator.nextElementSibling?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		expect(
			separator.nextElementSibling?.nextElementSibling?.textContent,
		).toContain("response line");
	});

	it("collapses consecutive blank lines in a prompt/response body to at most one", () => {
		renderTranscript({
			primary: {
				sessionId: "session-1",
				lines: [
					{ text: "heading", role: "input" },
					{ text: "", role: "input" },
					{ text: "", role: "input" },
					{ text: "", role: "input" },
					{ text: "after single blank", role: "input" },
				],
			},
			lanes: [],
			currentPair: 1,
			pairCount: 1,
		});

		const primary = screen.getByTestId("transcript-primary");
		// All same-role lines collapse into one pre-wrap text block whose three
		// stored blank lines are reduced to a single one (`\n\n`).
		const inputBlock = Array.from(primary.querySelectorAll("div")).find(
			(node) => node.textContent?.includes("heading"),
		);
		expect(inputBlock?.textContent).toBe("heading\n\nafter single blank");
		// No separator inside a single-role block.
		expect(
			primary.querySelector('[data-testid="transcript-separator"]'),
		).toBeNull();
	});

	it("retains a single real blank line between paragraphs (it is a visible blank row)", () => {
		renderTranscript({
			primary: {
				sessionId: "session-1",
				lines: [
					{ text: "paragraph one", role: "input" },
					{ text: "", role: "input" },
					{ text: "paragraph two", role: "input" },
				],
			},
			lanes: [],
			currentPair: 1,
			pairCount: 1,
		});

		const primary = screen.getByTestId("transcript-primary");
		// One blank line (`\n\n`) is exactly one blank line, so it stays — the
		// two paragraphs are separated by a visible blank row.
		const inputBlock = Array.from(primary.querySelectorAll("div")).find(
			(node) => node.textContent?.includes("paragraph one"),
		);
		expect(inputBlock?.textContent).toBe(
			"paragraph one\n\nparagraph two",
		);
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
			currentPair: 1,
			pairCount: 1,
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
					currentPair: 0,
					pairCount: 0,
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
					currentPair: 0,
					pairCount: 0,
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
					currentPair: 0,
					pairCount: 0,
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

	it("renders the first/prev/next/last buttons with ends disabled", () => {
		// Middle pair: all four buttons enabled and clickable.
		const onFirst = vi.fn();
		const onPrev = vi.fn();
		const onNext = vi.fn();
		const onLast = vi.fn();
		const { unmount } = render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "middle", role: "output" }],
					},
					lanes: [],
					currentPair: 2,
					pairCount: 3,
				}}
				loading={false}
				onFirst={onFirst}
				onPrev={onPrev}
				onNext={onNext}
				onLast={onLast}
			/>,
		);

		// All four buttons present; the position reads "2 / 3".
		expect(screen.getByTestId("transcript-position")).toHaveTextContent(
			"2 / 3",
		);
		for (const name of ["first", "prev", "next", "last"] as const) {
			const button = screen.getByTestId(`transcript-${name}`);
			expect(button).not.toBeDisabled();
			button.click();
		}
		expect(onFirst).toHaveBeenCalledTimes(1);
		expect(onPrev).toHaveBeenCalledTimes(1);
		expect(onNext).toHaveBeenCalledTimes(1);
		expect(onLast).toHaveBeenCalledTimes(1);
		unmount();

		// First pair: First/Prev disabled, Next/Last enabled.
		const first = render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "first", role: "output" }],
					},
					lanes: [],
					currentPair: 1,
					pairCount: 3,
				}}
				loading={false}
				onNext={() => undefined}
				onLast={() => undefined}
			/>,
		);
		expect(screen.getByTestId("transcript-first")).toBeDisabled();
		expect(screen.getByTestId("transcript-prev")).toBeDisabled();
		expect(screen.getByTestId("transcript-next")).not.toBeDisabled();
		expect(screen.getByTestId("transcript-last")).not.toBeDisabled();
		first.unmount();

		// Last pair: Next/Last disabled, First/Prev enabled.
		render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "last", role: "output" }],
					},
					lanes: [],
					currentPair: 3,
					pairCount: 3,
				}}
				loading={false}
				onFirst={() => undefined}
				onPrev={() => undefined}
			/>,
		);
		expect(screen.getByTestId("transcript-first")).not.toBeDisabled();
		expect(screen.getByTestId("transcript-prev")).not.toBeDisabled();
		expect(screen.getByTestId("transcript-next")).toBeDisabled();
		expect(screen.getByTestId("transcript-last")).toBeDisabled();
	});

	it("shows every navigation button disabled for a single-pair (or empty) session", () => {
		// A single pair: all four buttons render but are disabled.
		const single = render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: {
						sessionId: "session-1",
						lines: [{ text: "only", role: "output" }],
					},
					lanes: [],
					currentPair: 1,
					pairCount: 1,
				}}
				loading={false}
				onFirst={() => undefined}
				onPrev={() => undefined}
				onNext={() => undefined}
				onLast={() => undefined}
			/>,
		);
		for (const name of ["first", "prev", "next", "last"] as const) {
			expect(screen.getByTestId(`transcript-${name}`)).toBeDisabled();
		}
		single.unmount();

		// No pairs: the position reads "no pairs" and all buttons disabled.
		render(
			<Transcript
				sessionId="session-1"
				transcript={{
					primary: { sessionId: "session-1", lines: [] },
					lanes: [],
					currentPair: 0,
					pairCount: 0,
				}}
				loading={false}
				onFirst={() => undefined}
				onPrev={() => undefined}
				onNext={() => undefined}
				onLast={() => undefined}
			/>,
		);
		expect(screen.getByTestId("transcript-position")).toHaveTextContent(
			"no pairs",
		);
		for (const name of ["first", "prev", "next", "last"] as const) {
			expect(screen.getByTestId(`transcript-${name}`)).toBeDisabled();
		}
	});
});
