/**
 * api.ts — the harness-workflow client API.
 *
 * The run configuration form's model selectors populate at runtime from the
 * server's model-list endpoint (ticket #32), and the session browser (parent
 * ticket #37) reads the read-only workspace → sessions tree and the selected
 * session's transcript from the server's session endpoints: GET /api/sessions
 * returns the two-level tree (workspaces with their enriched sessions — each
 * carrying a readable label, its creation time, top-3, subagent-filtered),
 * and GET /api/sessions/:id/transcript returns the selected session's
 * recent ~100-line window — primary-only, with per-line roles and (when a run
 * is live) the live lane windows (child #46). These thin fetch wrappers mirror
 * the shapes the server serves (see src/session-tree.ts and
 * src/session-transcript.ts), so the client and the server agree on the
 * session-browser contract. The workspace dropdown is gone (parent #37): the
 * run continues the session picked in the tree, so there is no workspace
 * fetch here.
 */

/** One selectable model option served by GET /api/models. */
export interface ModelOption {
	/** Provider route that owns this model. */
	readonly provider: string;
	/** Model id sent to the provider (also the option's value). */
	readonly id: string;
	/** Human-readable model name shown in the dropdown. */
	readonly name: string;
}

/** The default model selected in each of the three slots. */
export interface DefaultModels {
	/** Model id for the orchestrator's primary agent. */
	readonly primary: string;
	/** Model id for the left lane's worker. */
	readonly left: string;
	/** Model id for the right lane's worker. */
	readonly right: string;
}

/** The response body of GET /api/models. */
export interface ModelsResponse {
	readonly models: readonly ModelOption[];
	readonly defaults: DefaultModels;
}

/** One session row under a workspace in the tree (mirror of SessionRow). */
export interface SessionRow {
	/** The session's id. */
	readonly id: string;
	/** The session's readable label: stored title, else a placeholder. */
	readonly label: string;
	/** Unix epoch ms of last activity (max(createdAt, last user prompt)), matching DSH web updatedAt. */
	readonly updatedAt: number;
}

/** One workspace node in the two-level tree (mirror of WorkspaceNode). */
export interface WorkspaceNode {
	/** Stable registry id (generated uuid). */
	readonly id: string;
	/** Canonical directory path. */
	readonly path: string;
	/** Display title. */
	readonly title: string;
	/** The workspace's sessions, each labeled by its readable label. */
	readonly sessions: readonly SessionRow[];
}

/** The read-only workspace → sessions tree served by GET /api/sessions. */
export type SessionTree = readonly WorkspaceNode[];

/** A transcript line's role: input (user), output (assistant), default. */
export type TranscriptRole = "input" | "output" | "default";

/** One rendered line of a transcript window (mirror of TranscriptLine). */
export interface TranscriptLine {
	/** The line's visible text (message blocks folded to text only). */
	readonly text: string;
	/** Whether this line is model input, model output, or the default style. */
	readonly role: TranscriptRole;
}

/** One agent's recent transcript window (mirror of TranscriptWindow). */
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
	 * in-memory. Stored subagent children are never read, so without a live
	 * run this is empty.
	 */
	readonly lanes: readonly TranscriptWindow[];
}

/** Fetch the configured model list and its agreed defaults from /api/models. */
export async function fetchModels(): Promise<ModelsResponse> {
	const res = await fetch("/api/models");
	if (!res.ok) {
		throw new Error(`GET /api/models failed with status ${res.status}`);
	}
	return (await res.json()) as ModelsResponse;
}

/** Fetch the read-only workspace → sessions tree from /api/sessions. */
export async function fetchSessions(): Promise<SessionTree> {
	const res = await fetch("/api/sessions");
	if (!res.ok) {
		throw new Error(`GET /api/sessions failed with status ${res.status}`);
	}
	return (await res.json()) as SessionTree;
}

/** Fetch one session's recent transcript window from the store. */
export async function fetchTranscript(
	sessionId: string,
): Promise<SessionTranscript> {
	const res = await fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
	);
	if (!res.ok) {
		throw new Error(
			`GET /api/sessions/${sessionId}/transcript failed with status ${res.status}`,
		);
	}
	return (await res.json()) as SessionTranscript;
}
