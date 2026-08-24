/**
 * Transcript.tsx — the selected session's transcript panel (parent ticket #37;
 * child ticket #46 makes the read primary-only with per-line roles; child
 * ticket #47 styles input vs output and shows the live lanes).
 *
 * The session browser's right panel: the selected session's recent ~100-line
 * window read from the shared store — primary-only (child #46): stored
 * subagent children are never read; each line carries a role the page styles,
 * and the two live lane-worker windows of our own in-progress run are supplied
 * on the read and rendered alongside the primary. Output is never assembled
 * from streamed deltas: the panel renders whatever the store read returned, and
 * a session/updated push (or a selection change) triggers a fresh store read.
 *
 * Per-line styling: model input (user-role) and model output (assistant-role)
 * each get a distinct background; every other line (tool/step/system) keeps
 * the default panel style — there is no third background.
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
}

/** One line's background class for its role (input/output styled; default). */
function roleClass(role: TranscriptRole): string {
	switch (role) {
		case "input":
			return "bg-sky-100 text-sky-900";
		case "output":
			return "bg-emerald-50 text-emerald-900";
		default:
			return "text-slate-600";
	}
}

/** One rendered line of a window, styled by its role. */
function Line({ line }: { readonly line: TranscriptLine }) {
	return (
		<div className={"px-1.5 py-0.5 " + roleClass(line.role)}>{line.text}</div>
	);
}

/** One agent's window (primary or live lane), each line styled by role. */
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
	return (
		<div className="flex flex-col gap-1">
			<h3 className="text-xs font-semibold text-slate-600">
				{label} · {sessionId}
			</h3>
			<pre
				data-testid={testId}
				className="flex min-h-[48px] flex-col whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-1.5 font-mono text-xs"
			>
				{lines.map((line, index) => (
					<Line key={index} line={line} />
				))}
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
}: TranscriptProps) {
	let body: ReactNode;
	if (sessionId === undefined) {
		body = (
			<div className="text-xs text-gray-500">
				Select a session to view its transcript.
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
		// A run's live content (its task + lane answers) belongs only to the
		// session it was submitted on; a different selection shows only that
		// session's store transcript.
		const isRunSession =
			runStart !== undefined && runStart.sessionId === sessionId;
		// The submitted task of our own run shows as the primary's input line
		// (the resumed orchestrator session itself is never driven, so the
		// question lives in the submitted task, not the stored primary window).
		const primaryLines: readonly TranscriptLine[] =
			isRunSession && runStart.task !== ""
				? [{ text: runStart.task, role: "input" }, ...transcript.primary.lines]
				: transcript.primary.lines;
		// The live lane answers streamed over the socket (kept after the run
		// ends) are the run session's lane windows. On a run session they
		// ALWAYS replace the store-read lanes — which would show only the
		// injected workspace context before the first delta arrives.
		const streamedLanes = (["left", "right"] as const)
			.map((laneId) => ({ laneId, text: laneTexts?.[laneId] ?? "" }))
			.filter((lane) => lane.text !== "");
		const laneWindows: readonly TranscriptWindow[] = isRunSession
			? streamedLanes.map((lane) => ({
					sessionId: "lane-" + lane.laneId,
					lines: [{ text: lane.text, role: "output" } as TranscriptLine],
				}))
			: transcript.lanes;
		body = (
			<div className="flex flex-col gap-2">
				<Window
					sessionId={transcript.primary.sessionId}
					lines={primaryLines}
					label="Primary"
					testId="transcript-primary"
				/>
				{laneWindows.map((window) => (
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
			{body}
		</section>
	);
}
