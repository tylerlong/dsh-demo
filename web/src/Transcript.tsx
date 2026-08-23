/**
 * Transcript.tsx — the selected session's transcript panel (parent ticket #37;
 * child ticket #46 makes the read primary-only with per-line roles).
 *
 * The session browser's right panel: the selected session's recent ~100-line
 * window read from the shared store — primary-only (child #46): stored subagent
 * children are never read; each line carries a role (input / output / default)
 * the page styles, and the two lane windows of a live in-progress run are
 * supplied on the read. Output is never assembled from streamed deltas: the
 * panel renders whatever the store read returned, and a session/updated push
 * (or a selection change) triggers a fresh store read. Sessions are labeled by
 * their id only (SessionHeader has no title field).
 */
import type { ReactNode } from "react";
import type { SessionTranscript } from "./api.ts";

export interface TranscriptProps {
	/** The selected session's id, or undefined before any selection. */
	readonly sessionId: string | undefined;
	/** The selected session's transcript read from the store, when loaded. */
	readonly transcript: SessionTranscript | undefined;
	/** Whether a store read is in flight. */
	readonly loading: boolean;
}

export function Transcript({
	sessionId,
	transcript,
	loading,
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
		const agents = [
			{ label: "Primary", window: transcript.primary },
			...transcript.lanes.map((window) => ({
				label: "Lane worker",
				window,
			})),
		];
		body = (
			<div className="flex flex-col gap-2">
				{agents.map((agent) => (
					<div key={agent.window.sessionId} className="flex flex-col gap-1">
						<h3 className="text-xs font-semibold text-slate-600">
							{agent.label} · {agent.window.sessionId}
						</h3>
						<pre
							data-testid={
								agent.label === "Primary"
									? "transcript-primary"
									: "transcript-worker"
							}
							className="min-h-[48px] whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-xs"
						>
							{agent.window.lines.map((line) => line.text).join("\n")}
						</pre>
					</div>
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
