/**
 * session-tree.ts — the read-only shared-store session-tree seam (ticket #38).
 *
 * The session browser's left panel lists the workspaces DSH web owns, each
 * expandable to its sessions, read from the shared workspace registry
 * (`ctx.workspaceRegistry`) and the shared session store
 * (`ctx.sessionPersistence`). This module is the thin adapter from those
 * harness entities to the neutral two-level tree shape the server serves over
 * GET /api/sessions (parent ticket #44, child ticket #45): workspaces with
 * their sessions, each session carrying a readable `label` — its stored
 * title from the store's projection read face when one exists, else a minimal
 * placeholder — plus its `createdAt` for recency.
 *
 * The seam makes the tree readable and focused:
 *   - only top-level conversations appear (`origin: 'subagent'` is filtered
 *     out), so the lane-worker children every run spawns never clutter the
 *     panel;
 *   - sessions within a workspace are ordered by `createdAt` descending
 *     (newest first) and capped at the top 3 per workspace, so a workspace
 *     with hundreds of stored sessions stays short;
 *   - workspaces are ordered by their newest (top) session's `createdAt`
 *     descending, so the workspace worked in most recently comes first.
 *
 * The label and origin come from the injected store slice's already-available
 * fields — no event-log scanning, no polling. harness-workflow is strictly
 * read-only over either service: it only calls `registry.list()` and
 * `sessionPersistence.list()`, never a mutation (no create / delete /
 * insertBefore / attachSession / setTitle / archiveSession — DSH web owns the
 * catalog). Keeping the harness vocabulary (Workspace / SessionHeader) here,
 * isolated from the HTTP + WebSocket layer, is what lets the server be tested
 * without booting the real harness (tests inject a fake `loadSessions`),
 * mirroring model-list.ts one-for-one. This seam supersedes the flat
 * workspace dropdown seam (workspace-list.ts, ticket #19): the tree is the
 * session browser's source, and the run's workspace derives from the selected
 * session, not a form selection.
 */

/** The top-N most-recent sessions shown per workspace (ticket #45). */
export const TOP_SESSIONS_PER_WORKSPACE = 3;

/** Minimal placeholder label for a session with no stored title. */
export const SESSION_LABEL_PLACEHOLDER = "Untitled session";

/** One session row under a workspace in the tree. */
export interface SessionRow {
	/** The session's id. */
	readonly id: string;
	/**
	 * The session's readable label: its stored title from the store's
	 * projection read face when one is set, else {@link SESSION_LABEL_PLACEHOLDER}.
	 */
	readonly label: string;
	/** Unix epoch milliseconds when the session was created. */
	readonly createdAt: number;
}

/** One workspace node in the two-level tree. */
export interface WorkspaceNode {
	/** Stable registry id (generated uuid). */
	readonly id: string;
	/** Canonical directory path. */
	readonly path: string;
	/** Display title. */
	readonly title: string;
	/** The workspace's top sessions, newest first, capped at TOP_SESSIONS_PER_WORKSPACE. */
	readonly sessions: readonly SessionRow[];
}

/** The narrow slice of the workspace registry this adapter needs. */
export interface WorkspaceRegistryLike {
	/** Synchronous ordered projection; performs no persistence reads. */
	list(): readonly {
		readonly id: string;
		readonly path: string;
		readonly title: string;
		readonly sessionIds: readonly string[];
	}[];
}

/**
 * The narrow slice of the shared session store this adapter needs. Each
 * header exposes the already-available fields the enriched tree requires: the
 * session's `createdAt`, its `origin` marker (subagent children are
 * filtered out), and its stored `label` (the store's title projection read
 * face) when one is set.
 */
export interface SessionStoreLike {
	/** Lightweight listing from metadata; headers carry createdAt, origin, label. */
	list(): Promise<
		readonly {
			readonly id: string;
			readonly createdAt: number;
			readonly origin?: "subagent";
			readonly label?: string;
		}[]
	>;
}

/**
 * Build the session tree for the server from the shared registry + session
 * store. Each session carries its readable `label` (stored title, else the
 * placeholder), filtered to top-level conversations, ordered newest-first and
 * capped at top 3 per workspace; workspaces are ordered by their newest
 * session. Strictly read-only: only `registry.list()` and `sessions.list()`,
 * never a mutation. Sessions listed by the registry but absent from the store
 * have no createdAt and are omitted — the store is the source of the
 * read-only listing.
 */
export async function convertSessionTree(
	registry: WorkspaceRegistryLike,
	sessions: SessionStoreLike,
): Promise<readonly WorkspaceNode[]> {
	const headers = await sessions.list();
	const byId = new Map<string, (typeof headers)[number]>();
	for (const header of headers) {
		byId.set(header.id, header);
	}
	const nodes = registry.list().map((workspace) => {
		// Only top-level conversations are shown: subagent children (the
		// lane workers every run spawns) never appear in the panel.
		const rows: SessionRow[] = [];
		for (const sessionId of workspace.sessionIds) {
			const header = byId.get(sessionId);
			if (header === undefined) {
				// Listed by the registry but absent from the store: omitted.
				continue;
			}
			if (header.origin === "subagent") {
				continue;
			}
			rows.push({
				id: sessionId,
				label: header.label ?? SESSION_LABEL_PLACEHOLDER,
				createdAt: header.createdAt,
			});
		}
		rows.sort((a, b) => b.createdAt - a.createdAt);
		return {
			id: workspace.id,
			path: workspace.path,
			title: workspace.title,
			sessions: rows.slice(0, TOP_SESSIONS_PER_WORKSPACE),
		};
	});
	// Workspaces ordered by their newest (top) session's createdAt, newest
	// first. A workspace with no sessions sorts after every workspace that
	// has one.
	nodes.sort((a, b) => {
		const aTop = a.sessions[0]?.createdAt ?? -Infinity;
		const bTop = b.sessions[0]?.createdAt ?? -Infinity;
		if (aTop === bTop) return 0;
		return aTop - bTop > 0 ? -1 : 1;
	});
	return nodes;
}
