/**
 * session-transcript.ts — the read-only store transcript seam (ticket #38,
 * child ticket #46).
 *
 * The right panel renders one agent's output by reading the shared session
 * store, showing one prompt/answer pair at a time rather than the full
 * history — reusing DSH web's display approach (fold the message-producing
 * surface events into text) instead of assembling output from streamed
 * deltas. This module is the thin adapter from the shared session store
 * (ctx.sessionPersistence) to that transcript shape the server serves over
 * GET /api/sessions/:id/transcript.
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
 * Pagination: the primary window shows exactly one prompt/answer pair (one
 * user prompt plus the model's output that responds to it). The read accepts
 * a `pair` selector — a 1-indexed pair number, or "last" (the default) — and
 * the response reports `currentPair` (which pair is shown) and `pairCount`
 * (how many pairs the session has), so the page can offer first/prev/next/
 * last navigation and disable the ends. Lanes are never paginated.
 *
 * The read is strictly read-only: it only calls store.inspect(id), never a
 * mutation (no create / append / prepare / resume). Mirroring the
 * WorkspaceRegistryLike / SessionStoreLike pattern, the narrow structural
 * store slice keeps the server testable without the real harness.
 */

/**
 * Which prompt/answer pair a transcript read returns: a 1-indexed pair
 * number, or "last" for the newest pair (the default view).
 */
export type TranscriptPair = number | "last";

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
	/** The recent window of the agent's transcript (lines of the shown pairs). */
	readonly lines: readonly TranscriptLine[];
}

/** The read-only transcript read for one selected session. */
export interface SessionTranscript {
	/** The selected (primary) session's shown pair. */
	readonly primary: TranscriptWindow;
	/**
	 * The live lane-worker windows of our own in-progress run, supplied
	 * in-memory. Stored subagent children are never read from the store, so
	 * without a live run this is empty.
	 */
	readonly lanes: readonly TranscriptWindow[];
	/**
	 * The 1-indexed pair number `primary` shows (0 when the session has no
	 * pairs). The page uses it with `pairCount` to enable/disable the
	 * first/prev/next/last navigation.
	 */
	readonly currentPair: number;
	/** The total number of prompt/answer pairs in the session. */
	readonly pairCount: number;
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

/**
 * Whether a user/assistant message carries the message's `source` inside its
 * event `data` (user/message carries it on `data.source`; assistant/tool
 * events nest it on `data.message.source`). Only `kind === "user"` is a typed
 * user prompt — every other source kind (skill-catalog, skill-invocation,
 * agent-instructions, plugin, …) is harness-internal model context, not the
 * user's words, and is hidden from the transcript. The true model reply is the
 * assistant message's `text` blocks (thinking/reasoning and tool-calls are
 * separate content-block types and never make it through textOfMessage).
 */
function isUserTypedMessage(event: TranscriptEvent): boolean {
	const data = isRecord(event.data) ? event.data : undefined;
	const source = data === undefined ? undefined : data.source;
	return isRecord(source) && source.kind === "user";
}

/** The visible text one message-producing event contributes, or undefined. */
function eventText(event: TranscriptEvent): string | undefined {
	switch (event.type) {
		case "user/message":
			// Only a typed user prompt (source.kind === "user") is shown; skill
			// invocations, the skill catalog reminder, agent instructions, and
			// plugin context are harness internals, not the user's words.
			return isUserTypedMessage(event) ? textOfMessage(event.data) : undefined;
		case "assistant/message": {
			// The true user-facing reply: the assistant message's text blocks.
			// Thinking/reasoning and tool-call content blocks are excluded by
			// textOfMessage (it reads text blocks only).
			if (!isRecord(event.data)) return undefined;
			return textOfMessage(event.data.message);
		}
		default:
			// Boundary markers, chunks, usage, log-only records, and tool
			// results (the model's tool-invocation history) contribute no
			// transcript text — only user-facing turns are shown.
			return undefined;
	}
}

/**
 * The role one shown event's line carries. Only user-typed prompts (input)
 * and assistant replies (output) are shown at all — eventText already dropped
 * everything else (harness-internal user sources, tool results, thinking).
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

/**
 * One folded prompt/answer message: its text (undivided) and the role of the
 * event that produced it. Kept apart from the rendered line list so the
 * windowing can group whole messages into pairs rather than counting lines.
 */
interface TranscriptMessage {
	readonly role: TranscriptRole;
	readonly text: string;
}

/** Fold the events into whole messages (input prompt, output answer). */
function foldMessages(events: readonly TranscriptEvent[]): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	for (const event of events) {
		const text = eventText(event);
		if (text === undefined) continue;
		messages.push({ role: eventRole(event), text });
	}
	return messages;
}

/**
 * Group messages into prompt/answer pairs: each pair is one user prompt plus
 * the output(s) that directly answer it, up to (not including) the next
 * prompt. The newest pair is the last message the session produced.
 */
function groupPairs(
	messages: readonly TranscriptMessage[],
): readonly (readonly TranscriptMessage[])[] {
	const pairs: TranscriptMessage[][] = [];
	for (const message of messages) {
		if (message.role === "input") {
			pairs.push([message]);
		} else {
			// An output answers the most recent prompt; a session that starts
			// with an orphan output (no preceding prompt in the fold) is its
			// own leading pair.
			const last = pairs[pairs.length - 1];
			if (last === undefined) {
				pairs.push([message]);
			} else {
				last.push(message);
			}
		}
	}
	return pairs;
}

/** Render one pair's messages as role-tagged lines. */
function linesOfPair(pair: readonly TranscriptMessage[]): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const message of pair) {
		for (const line of message.text.split("\n")) {
			lines.push({ text: line, role: message.role });
		}
	}
	return lines;
}

/** Resolve a pair selector to a 0-based pair index, clamped to the session. */
function pairIndex(
	pairs: readonly (readonly TranscriptMessage[])[],
	pair: TranscriptPair,
): number {
	if (pair === "last") return pairs.length - 1;
	return Math.min(Math.max(pair - 1, 0), pairs.length - 1);
}

/** One session's folded pair plus its position in the session. */
export interface TranscriptPairRead {
	/** The shown pair's window (one prompt/answer pair). */
	readonly window: TranscriptWindow;
	/** The 1-indexed pair shown (0 when the session has no pairs). */
	readonly currentPair: number;
	/** The total number of pairs in the session. */
	readonly pairCount: number;
}

/** Read one session's shown pair from the store. */
async function windowOf(
	store: TranscriptStoreLike,
	sessionId: string,
	pair: TranscriptPair,
): Promise<TranscriptPairRead> {
	const inspection = await store.inspect(sessionId);
	return transcriptPairFromEvents(sessionId, inspection.events, pair);
}

/**
 * Fold one session's events into the shown prompt/answer pair. This is the
 * pure fold `windowOf` applies to a store inspection; harness-adapters reuses
 * it for the spliced-session tolerant decode (child #62), which reads the raw
 * JSONL and recovers a contiguous event stream the strict store read refuses.
 * `pair` selects which pair to show (1-indexed, or "last" for the newest);
 * `currentPair`/`pairCount` report the shown position and the session's total
 * so the page can navigate first/prev/next/last.
 */
export function transcriptPairFromEvents(
	sessionId: string,
	events: readonly TranscriptEvent[],
	pair: TranscriptPair = "last",
): TranscriptPairRead {
	const pairs = groupPairs(foldMessages(events));
	const pairCount = pairs.length;
	if (pairCount === 0) {
		return {
			window: { sessionId, lines: [] },
			currentPair: 0,
			pairCount: 0,
		};
	}
	const index = pairIndex(pairs, pair);
	const shown = pairs[index];
	return {
		window: { sessionId, lines: shown === undefined ? [] : linesOfPair(shown) },
		currentPair: index + 1,
		pairCount,
	};
}

/**
 * Read the selected session's shown prompt/answer pair — primary-only. Only
 * the selected session's own pair is read from the store; stored subagent
 * children are never read (no parentSession lookup). The two lane-worker
 * outputs of a live run are supplied separately as liveLanes (in-memory,
 * this run's children) and carried through SessionTranscript.lanes, so a
 * live run renders alongside the primary without the transcript read ever
 * touching stored subagent history. `pair` selects the shown pair (1-indexed,
 * or "last" for the newest; default "last") and the response reports
 * `currentPair`/`pairCount` so the page can navigate. Strictly read-only —
 * only store.inspect(), never a mutation.
 */
export async function convertSessionTranscript(
	store: TranscriptStoreLike,
	sessionId: string,
	liveLanes: readonly TranscriptWindow[] = [],
	pair: TranscriptPair = "last",
): Promise<SessionTranscript> {
	const primary = await windowOf(store, sessionId, pair);
	return {
		primary: primary.window,
		lanes: liveLanes,
		currentPair: primary.currentPair,
		pairCount: primary.pairCount,
	};
}
