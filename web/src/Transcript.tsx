/**
 * Transcript.tsx — the selected session's transcript panel (parent ticket #37;
 * child ticket #46 makes the read primary-only with per-line roles; child
 * ticket #47 styles input vs output and shows the live lanes).
 *
 * The session browser's right panel: the selected session's recent
 * prompt/answer window read from the shared store — primary-only (child #46):
 * stored subagent children are never read; each line carries a role the page
 * styles, and the two live lane-worker windows of our own in-progress run are
 * supplied on the read and rendered alongside the primary. Output is never
 * assembled from streamed deltas: the panel renders whatever the store read
 * returned, and a session/updated push (or a selection change) triggers a
 * fresh store read.
 *
 * Per-line styling: model input (user-role) and model output (assistant-role)
 * each get a distinct background; every other line (tool/step/system) keeps
 * the default panel style — there is no third background.
 *
 * Navigation: the transcript shows exactly one prompt/answer pair at a time.
 * Four buttons (First / Prev / Next / Last) move between pairs; First and
 * Prev are disabled on the oldest pair, Next and Last on the newest, all
 * four disabled when the session has a single pair (or none).
 */
import type { ReactNode } from "react";
import type { LaneId } from "../../shared/protocol.ts";
import type {
	SessionTranscript,
	TranscriptLine,
	TranscriptRole,
	TranscriptWindow,
} from "./api.ts";

export interface TranscriptProps {
	/** The selected session's id, or undefined before any selection. */
	readonly sessionId: string | undefined;
	/** The selected session's transcript read from the store, when loaded. */
	readonly transcript: SessionTranscript | undefined;
	/** Whether a store read is in flight. */
	readonly loading: boolean;
	/**
	 * The live lane-worker answers streamed over the socket for our own run
	 * (lane/worker/delta), kept after the run ends. When any lane has text,
	 * these render as the lane windows (the store read of the child session
	 * shows only the injected workspace context, not the answer).
	 */
	readonly laneTexts?: Partial<Record<LaneId, string>>;
	/**
	 * The run that actually began, bound to its session: the submitted task
	 * (shown as that session's primary input line) and the session the lane
	 * answers belong to. Only rendered when it matches the selected session,
	 * so switching sessions never shows one run's content under another's
	 * transcript. While a run is bound to the selected session, the streamed
	 * lane answers replace the store-read lane windows (which would show only
	 * the injected workspace context, never the answer) even before the first
	 * delta arrives.
	 */
	readonly runStart?: { sessionId: string; task: string } | undefined;
	/**
	 * Navigate to the first pair. Rendered as a "First" button; disabled when
	 * the shown pair is already the first (or the session has no pairs).
	 */
	readonly onFirst?: () => void;
	/**
	 * Navigate to the previous pair. Rendered as a "Prev" button; disabled on
	 * the first pair (or when there are no pairs).
	 */
	readonly onPrev?: () => void;
	/**
	 * Navigate to the next pair. Rendered as a "Next" button; disabled on the
	 * last pair (or when there are no pairs).
	 */
	readonly onNext?: () => void;
	/**
	 * Navigate to the last (newest) pair. Rendered as a "Last" button; disabled
	 * when the shown pair is already the last (or there are no pairs).
	 */
	readonly onLast?: () => void;
}

/** One line's text color for its role. Prompts and responses share the plain
 * panel style (no background) and are told apart by a separator; only the
 * default/tool lines are dimmed. */
function roleClass(role: TranscriptRole): string {
	switch (role) {
		case "input":
			return "text-slate-900";
		case "output":
			return "text-slate-900";
		default:
			return "text-slate-600";
	}
}

/** One rendered group of contiguous same-role lines, kept as flowing text so
 * its internal line breaks and blank lines render like ordinary text. */
function Block({
	role,
	text,
}: {
	readonly role: TranscriptRole;
	readonly text: string;
}) {
	return (
		<div className={"px-1.5 py-0.5 " + roleClass(role)}>{text}</div>
	);
}

/** Collapse runs of blank lines in text to a single blank line. A blank line
 * is one empty row — two consecutive line breaks (`\n\n`); three or more
 * breaks (`\n{3,}`) mean two or more blank lines and are reduced to one. */
function collapseBlankRuns(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n");
}

/** One agent's window (primary or live lane), blank lines capped at one. */
function Window({
	sessionId,
	lines,
	label,
	testId,
}: {
	readonly sessionId: string;
	readonly lines: readonly TranscriptLine[];
	readonly label: string;
	readonly testId: string;
}) {
	// Group consecutive same-role lines into blocks of flowing text, so blank
	// lines inside a prompt/response body stay real blank rows (at most one at
	// a time), rather than empty per-line boxes that collapse to nothing.
	const blocks: Array<{ role: TranscriptRole; rows: string[] }> = [];
	for (const line of lines) {
		const last = blocks[blocks.length - 1];
		if (last !== undefined && last.role === line.role) {
			last.rows.push(line.text);
		} else {
			blocks.push({ role: line.role, rows: [line.text] });
		}
	}

	// A separator (with one blank line above and below it) splits different
	// roles — the prompt and the response — since neither carries a background.
	const rendered: ReactNode[] = [];
	blocks.forEach((block, index) => {
		if (index > 0) {
			rendered.push(
				// biome-ignore lint/suspicious/noArrayIndexKey: built once per render from immutable blocks, keys are stable.
				<div key={`sep-up-${index}`} className="h-4" aria-hidden="true" />,
				// biome-ignore lint/suspicious/noArrayIndexKey: built once per render from immutable blocks, keys are stable.
				<div
					key={`sep-${index}`}
					data-testid="transcript-separator"
					className="border-t border-slate-300"
				/>,
				// biome-ignore lint/suspicious/noArrayIndexKey: built once per render from immutable blocks, keys are stable.
				<div key={`sep-down-${index}`} className="h-4" aria-hidden="true" />,
			);
		}
		const text = collapseBlankRuns(block.rows.join("\n"));
		// biome-ignore lint/suspicious/noArrayIndexKey: blocks are an immutable render-only grouping, keys are stable.
		rendered.push(<Block key={`block-${index}`} role={block.role} text={text} />);
	});
	return (
		<div className="flex flex-col gap-1">
			<h3 className="text-xs font-semibold text-slate-600">
				{label} · {sessionId}
			</h3>
			<pre
				data-testid={testId}
				className="flex min-h-[48px] flex-col whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-1.5 font-mono text-xs"
			>
				{rendered}
			</pre>
		</div>
	);
}

export function Transcript({
	sessionId,
	transcript,
	loading,
	laneTexts,
	runStart,
	onFirst,
	onPrev,
	onNext,
	onLast,
}: TranscriptProps) {
	// A run's live content (its task + lane answers) belongs only to the
	// session it was submitted on; a different selection shows only that
	// session's store transcript.
	const isRunSession =
		runStart !== undefined && runStart.sessionId === sessionId;
	// Navigation bounds come from the shown pair's position: First/Prev are
	// enabled only when there is an earlier pair, Next/Last only when there is
	// a later one (a callback is required to act on the press).
	const currentPair = transcript?.currentPair ?? 0;
	const pairCount = transcript?.pairCount ?? 0;
	const canGoEarlier = currentPair > 1;
	const canGoLater = currentPair < pairCount;
	const canFirst = canGoEarlier && onFirst !== undefined;
	const canPrev = canGoEarlier && onPrev !== undefined;
	const canNext = canGoLater && onNext !== undefined;
	const canLast = canGoLater && onLast !== undefined;
	const navButtonClass =
		"rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 enabled:hover:bg-slate-100 enabled:hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40";
	const navButtons =
		sessionId !== undefined ? (
			<div className="flex items-center justify-center gap-2">
				<button
					type="button"
					data-testid="transcript-first"
					disabled={!canFirst}
					onClick={onFirst}
					className={navButtonClass}
				>
					First
				</button>
				<button
					type="button"
					data-testid="transcript-prev"
					disabled={!canPrev}
					onClick={onPrev}
					className={navButtonClass}
				>
					Prev
				</button>
				<span
					data-testid="transcript-position"
					className="px-2 text-xs text-slate-500"
				>
					{pairCount > 0
						? `${currentPair} / ${pairCount}`
						: "no pairs"}
				</span>
				<button
					type="button"
					data-testid="transcript-next"
					disabled={!canNext}
					onClick={onNext}
					className={navButtonClass}
				>
					Next
				</button>
				<button
					type="button"
					data-testid="transcript-last"
					disabled={!canLast}
					onClick={onLast}
					className={navButtonClass}
				>
					Last
				</button>
			</div>
		) : null;
	// The submitted task of our own run shows as the primary's input line
	// (the resumed orchestrator session itself is never driven, so the
	// question lives in the submitted task, not the stored primary window).
	const runTaskLine: TranscriptLine[] =
		isRunSession && runStart.task !== ""
			? [{ text: runStart.task, role: "input" }]
			: [];
	// The live lane answers streamed over the socket (kept after the run
	// ends) are the run session's lane windows. On a run session they
	// ALWAYS replace the store-read lanes — which would show only the
	// injected workspace context before the first delta arrives.
	const streamedLanes = (["left", "right"] as const)
		.map((laneId) => ({ laneId, text: laneTexts?.[laneId] ?? "" }))
		.filter((lane) => lane.text !== "");
	const runLaneWindows: readonly TranscriptWindow[] = streamedLanes.map(
		(lane) => ({
			sessionId: "lane-" + lane.laneId,
			lines: [{ text: lane.text, role: "output" } as TranscriptLine],
		}),
	);

	let body: ReactNode;
	if (sessionId === undefined) {
		body = (
			<div className="text-xs text-gray-500">
				Select a session to view its transcript.
			</div>
		);
	} else if (isRunSession) {
		// The run's own content renders regardless of the store read — a
		// selection change or a failed read must never blank the question and
		// the streamed answers ("nothing left in the UI").
		const primaryLines: readonly TranscriptLine[] = [
			...runTaskLine,
			...(transcript?.primary.lines ?? []),
		];
		body = (
			<div className="flex flex-col gap-2">
				<Window
					sessionId={sessionId}
					lines={primaryLines}
					label="Primary"
					testId="transcript-primary"
				/>
				{runLaneWindows.map((window) => (
					<Window
						key={window.sessionId}
						sessionId={window.sessionId}
						lines={window.lines}
						label="Lane worker"
						testId="transcript-worker"
					/>
				))}
			</div>
		);
	} else if (loading) {
		body = <div className="text-xs text-gray-500">Loading transcript…</div>;
	} else if (transcript === undefined) {
		body = (
			<div className="text-xs text-gray-500">
				No transcript available for this session.
			</div>
		);
	} else {
		body = (
			<div className="flex flex-col gap-2">
				<Window
					sessionId={transcript.primary.sessionId}
					lines={transcript.primary.lines}
					label="Primary"
					testId="transcript-primary"
				/>
				{transcript.lanes.map((window) => (
					<Window
						key={window.sessionId}
						sessionId={window.sessionId}
						lines={window.lines}
						label="Lane worker"
						testId="transcript-worker"
					/>
				))}
			</div>
		);
	}

	return (
		<section
			aria-label="Transcript"
			className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4"
		>
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold">Transcript</h2>
				{sessionId !== undefined && (
					<span
						data-testid="transcript-session"
						className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600"
					>
						{sessionId}
					</span>
				)}
			</div>
			{navButtons}
			{body}
		</section>
	);
}
