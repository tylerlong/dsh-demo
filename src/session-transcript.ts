/**
 * session-transcript.ts — the read-only store transcript seam (ticket #38).
 *
 * The right panel renders each agent's output (the primary agent and its two
 * lane-worker children) by reading the shared session store, showing a recent
 * ~100-line window rather than the full history — reusing DSH web's display
 * approach (fold the message-producing surface events into text) instead of
 * assembling output from streamed deltas. This module is the thin adapter
 * from the shared session store (`ctx.sessionPersistence`) to that transcript
 * window shape the server serves over GET /api/sessions/:id/transcript.
 *
 * The read is strictly read-only: it only calls `store.list()` (to find the
 * selected session's lane-worker children via their `parentSession` header)
 * and `store.inspect(id)` (to read each session's immutable log) — never a
 * mutation (no create / append / prepare / resume). Mirroring the
 * WorkspaceRegistryLike / SessionStoreLike pattern, the narrow structural
 * store slice keeps the server testable without the real harness.
 */

/** The number of lines in the recent transcript window. */
export const TRANSCRIPT_WINDOW_LINES = 100;

/** One agent's recent transcript window read from the store. */
export interface TranscriptWindow {
	/** The session id this window was read from. */
	readonly sessionId: string;
	/** The recent ~100-line window of the agent's transcript text. */
	readonly lines: readonly string[];
}

/** The read-only transcript read for one selected session. */
export interface SessionTranscript {
	/** The selected (primary) session's window. */
	readonly primary: TranscriptWindow;
	/** The lane-worker children's windows (found via `parentSession`). */
	readonly lanes: readonly TranscriptWindow[];
}

/** The minimal session event shape the transcript read consumes. */
export interface TranscriptEvent {
	readonly type: string;
	readonly data: unknown;
}

/** The narrow slice of the shared session store the transcript read needs. */
export interface TranscriptStoreLike {
	/** Lightweight listing from metadata; headers carry parentSession lineage. */
	list(): Promise<
		readonly { readonly id: string; readonly parentSession?: string }[]
	>;
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

/** Keep only the recent ~100-line window (the tail of the transcript). */
function recentWindow(lines: readonly string[]): readonly string[] {
	return lines.length <= TRANSCRIPT_WINDOW_LINES
		? lines
		: lines.slice(lines.length - TRANSCRIPT_WINDOW_LINES);
}

/** Read one session's recent transcript window from the store. */
async function windowOf(
	store: TranscriptStoreLike,
	sessionId: string,
): Promise<TranscriptWindow> {
	const inspection = await store.inspect(sessionId);
	const lines: string[] = [];
	for (const event of inspection.events) {
		const text = eventText(event);
		if (text === undefined) continue;
		for (const line of text.split("\n")) {
			lines.push(line);
		}
	}
	return { sessionId, lines: recentWindow(lines) };
}

/**
 * Read the selected session's recent transcript: the primary session's window
 * plus each lane-worker child's window (children found via their
 * `parentSession` header). Strictly read-only — only `store.list()` and
 * `store.inspect()`, never a mutation.
 */
export async function convertSessionTranscript(
	store: TranscriptStoreLike,
	sessionId: string,
): Promise<SessionTranscript> {
	const headers = await store.list();
	const children = headers
		.filter((header) => header.parentSession === sessionId)
		.map((header) => header.id);
	const lanes: TranscriptWindow[] = [];
	for (const childId of children) {
		lanes.push(await windowOf(store, childId));
	}
	return {
		primary: await windowOf(store, sessionId),
		lanes,
	};
}
