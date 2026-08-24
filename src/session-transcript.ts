/**
 * session-transcript.ts — the read-only store transcript seam (ticket #38,
 * child ticket #46).
 *
 * The right panel renders one agent's output by reading the shared session
 * store, showing a recent ~100-line window rather than the full history —
 * reusing DSH web's display approach (fold the message-producing surface
 * events into text) instead of assembling output from streamed deltas. This
 * module is the thin adapter from the shared session store
 * (ctx.sessionPersistence) to that transcript window shape the server serves
 * over GET /api/sessions/:id/transcript.
 *
 * Child ticket #46 makes the read primary-only with per-line roles and live
 * lanes:
 *
 *  - primary-only — the read returns only the selected session's own
 *    recent window. It never reads stored subagent children (there is no
 *    store.list() parentSession lookup here anymore), so a session with
 *    hundreds of old subtree agents never renders their histories.
 *  - per-line roles — every rendered line carries a role
 *    (input / output / default) derived from the producing event, so
 *    the page can style what was fed to the model (user-role) vs what it
 *    produced (assistant-role).
 *  - live lanes — the two lane-worker outputs of our own in-progress run
 *    are supplied separately (in-memory, this run's children) and carried
 *    through SessionTranscript.lanes; the seam never reads them from the
 *    store. With no live run, lanes is empty.
 *
 * Pagination: the primary window defaults to the recent ~100-line tail, and
 * the read accepts a larger `limit` (the last N lines) so the page's "load
 * more" can grow the window backward by TRANSCRIPT_WINDOW_LINES at a time.
 * `moreBefore` reports whether lines exist before the returned window, so the
 * page knows when to stop offering more. Lanes are never paginated.
 *
 * The read is strictly read-only: it only calls store.inspect(id), never a
 * mutation (no create / append / prepare / resume). Mirroring the
 * WorkspaceRegistryLike / SessionStoreLike pattern, the narrow structural
 * store slice keeps the server testable without the real harness.
 */

/** The number of lines in the recent transcript window. */
export const TRANSCRIPT_WINDOW_LINES = 100;

/** The largest window a single transcript read may request (payload bound). */
export const TRANSCRIPT_WINDOW_LIMIT_MAX = 1000;

/**
 * A line's role, so the page can style what was fed to the model vs what it
 * produced. input — a user/request line; output — an assistant/response
 * line; default — every tool/step/system line.
 */
export type TranscriptRole = "input" | "output" | "default";

/** One rendered line of the transcript window. */
export interface TranscriptLine {
	/** The line's visible text (message blocks folded to text only). */
	readonly text: string;
	/** Whether this line is model input, model output, or the default style. */
	readonly role: TranscriptRole;
}

/** One agent's recent transcript window read from the store. */
export interface TranscriptWindow {
	/** The session id this window was read from. */
	readonly sessionId: string;
	/** The recent ~100-line window of the agent's transcript. */
	readonly lines: readonly TranscriptLine[];
}

/** The read-only transcript read for one selected session. */
export interface SessionTranscript {
	/** The selected (primary) session's window. */
	readonly primary: TranscriptWindow;
	/**
	 * The live lane-worker windows of our own in-progress run, supplied
	 * in-memory. Stored subagent children are never read from the store, so
	 * without a live run this is empty.
	 */
	readonly lanes: readonly TranscriptWindow[];
	/**
	 * Whether the primary session has more stored lines before the returned
	 * window (the fold found more than `limit` lines). The page offers "load
	 * more" only while this is true; lanes are never paginated.
	 */
	readonly moreBefore: boolean;
}

/** The minimal session event shape the transcript read consumes. */
export interface TranscriptEvent {
	readonly type: string;
	readonly data: unknown;
}

/** The narrow slice of the shared session store the transcript read needs. */
export interface TranscriptStoreLike {
	/** Immutable logical session read; never mutates the store. */
	inspect(id: string): Promise<{
		readonly meta: { readonly id: string; readonly parentSession?: string };
		readonly events: readonly TranscriptEvent[];
	}>;
}

/** Narrow an unknown value to a plain record, or undefined otherwise. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Extract the visible text of a message's content blocks (text blocks only). */
function textOfMessage(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** The visible text one message-producing event contributes, or undefined. */
function eventText(event: TranscriptEvent): string | undefined {
	switch (event.type) {
		case "user/message":
			return textOfMessage(event.data);
		case "assistant/message":
		case "tool/result": {
			if (!isRecord(event.data)) return undefined;
			return textOfMessage(event.data.message);
		}
		default:
			// Boundary markers, chunks, usage, and log-only records contribute
			// no transcript text (mirrors DSH web's surface fold).
			return undefined;
	}
}

/**
 * The role one message-producing event's line carries. What was fed to the
 * model (user/message) is input; what the model produced (assistant/
 * message) is output; everything else (tool results, etc.) is default.
 */
function eventRole(event: TranscriptEvent): TranscriptRole {
	switch (event.type) {
		case "user/message":
			return "input";
		case "assistant/message":
			return "output";
		default:
			return "default";
	}
}

/** Keep only the recent N-line window (the tail of the transcript). */
function recentWindow(
	lines: readonly TranscriptLine[],
	limit: number,
): readonly TranscriptLine[] {
	return lines.length <= limit ? lines : lines.slice(lines.length - limit);
}

/** One session's folded window plus whether more lines exist before it. */
export interface TranscriptWindowRead {
	/** The recent N-line window of the session's transcript. */
	readonly window: TranscriptWindow;
	/** Whether the session has more lines before the returned window. */
	readonly moreBefore: boolean;
}

/** Read one session's recent transcript window from the store. */
async function windowOf(
	store: TranscriptStoreLike,
	sessionId: string,
	limit: number,
): Promise<TranscriptWindowRead> {
	const inspection = await store.inspect(sessionId);
	return transcriptWindowFromEvents(sessionId, inspection.events, limit);
}

/**
 * Fold one session's events into its recent transcript window. This is the
 * pure fold `windowOf` applies to a store inspection; harness-adapters reuses
 * it for the spliced-session tolerant decode (child #62), which reads the raw
 * JSONL and recovers a contiguous event stream the strict store read refuses.
 * `limit` sizes the window (default TRANSCRIPT_WINDOW_LINES); `moreBefore`
 * reports whether the session has more lines before the returned window.
 */
export function transcriptWindowFromEvents(
	sessionId: string,
	events: readonly TranscriptEvent[],
	limit: number = TRANSCRIPT_WINDOW_LINES,
): TranscriptWindowRead {
	const lines: TranscriptLine[] = [];
	for (const event of events) {
		const text = eventText(event);
		if (text === undefined) continue;
		const role = eventRole(event);
		for (const line of text.split("\n")) {
			lines.push({ text: line, role });
		}
	}
	return {
		window: { sessionId, lines: recentWindow(lines, limit) },
		moreBefore: lines.length > limit,
	};
}

/**
 * Read the selected session's recent transcript — primary-only. Only the
 * selected session's own window is read from the store; stored subagent
 * children are never read (no parentSession lookup). The two lane-worker
 * outputs of a live run are supplied separately as liveLanes (in-memory,
 * this run's children) and carried through SessionTranscript.lanes, so a
 * live run renders alongside the primary without the transcript read ever
 * touching stored subagent history. `limit` sizes the primary window (last N
 * lines; default TRANSCRIPT_WINDOW_LINES) and `moreBefore` reports whether
 * more lines exist before it. Strictly read-only — only store.inspect(),
 * never a mutation.
 */
export async function convertSessionTranscript(
	store: TranscriptStoreLike,
	sessionId: string,
	liveLanes: readonly TranscriptWindow[] = [],
	limit: number = TRANSCRIPT_WINDOW_LINES,
): Promise<SessionTranscript> {
	const primary = await windowOf(store, sessionId, limit);
	return {
		primary: primary.window,
		lanes: liveLanes,
		moreBefore: primary.moreBefore,
	};
}
