/**
 * session-tree.ts — the read-only shared-store session-tree seam (ticket #38).
 *
 * The session browser's left panel lists the workspaces DSH web owns, each
 * expandable to its sessions, read from the shared workspace registry
 * (`ctx.workspaceRegistry`) and the shared session store
 * (`ctx.sessionPersistence`). This module is the thin adapter from those
 * harness entities to the neutral two-level tree shape the server serves over
 * GET /api/sessions: workspaces with their sessions (id, createdAt), each
 * session labeled by its id — the only stable label the read-only listing
 * provides (SessionHeader has no title field; never invent one).
 *
 * harness-workflow is strictly read-only over both: it only calls
 * `registry.list()` and `sessionPersistence.list()`, never a mutation (no
 * create / delete / insertBefore / attachSession / setTitle / archiveSession —
 * DSH web owns the catalog). Keeping the harness vocabulary (Workspace /
 * SessionHeader) here, isolated from the HTTP + WebSocket layer, is what lets
 * the server be tested without booting the real harness (tests inject a fake
 * `loadSessions`), mirroring model-list.ts one-for-one. This seam supersedes
 * the flat workspace dropdown seam (workspace-list.ts, ticket #19): the tree
 * is the session browser's source, and the run's workspace derives from the
 * selected session, not a form selection.
 */

/** One session row under a workspace in the tree. */
export interface SessionRow {
	/** The session's id; also its label (the only stable label). */
	readonly id: string;
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
	/** The workspace's sessions, each labeled by its id. */
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

/** The narrow slice of the shared session store this adapter needs. */
export interface SessionStoreLike {
	/** Lightweight listing from metadata; each header carries its createdAt. */
	list(): Promise<
		readonly { readonly id: string; readonly createdAt: number }[]
	>;
}

/**
 * Build the session tree for the server from the shared registry + session
 * store. Each workspace carries its sessions (id, createdAt), each labeled by
 * its id. Strictly read-only: only `registry.list()` and `sessions.list()`,
 * never a mutation. Sessions listed by the registry but absent from the store
 * have no createdAt and are omitted — the store is the source of the
 * read-only listing.
 */
export async function convertSessionTree(
	registry: WorkspaceRegistryLike,
	sessions: SessionStoreLike,
): Promise<readonly WorkspaceNode[]> {
	const headers = await sessions.list();
	const createdAt = new Map<string, number>();
	for (const header of headers) {
		createdAt.set(header.id, header.createdAt);
	}
	return registry.list().map((workspace) => {
		const rows: SessionRow[] = [];
		for (const sessionId of workspace.sessionIds) {
			const timestamp = createdAt.get(sessionId);
			if (timestamp !== undefined) {
				rows.push({ id: sessionId, createdAt: timestamp });
			}
		}
		return {
			id: workspace.id,
			path: workspace.path,
			title: workspace.title,
			sessions: rows,
		};
	});
}
