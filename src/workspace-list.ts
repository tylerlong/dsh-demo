/**
 * workspace-list.ts — the shared-registry workspace seam for the dropdown.
 *
 * The workspace dropdown lists the workspaces DSH web owns, read from the
 * shared workspace registry (`ctx.workspaceRegistry`, mounted by the storage
 * stack in boot.ts / storage.cordis.patch.yml). This module is the thin
 * adapter from the registry's `Workspace` entities to the neutral row shape
 * the server serves over GET /api/workspaces: the id, the canonical path, the
 * display title, and — for the preselect — the newest session's creation
 * timestamp, derived from the shared session store
 * (`ctx.sessionPersistence`).
 *
 * harness-workflow is read-only over both: it only calls `registry.list()` and
 * `sessionPersistence.list()`, never a mutation (no create / delete /
 * insertBefore / attachSession / setTitle / archiveSession — DSH web owns the
 * catalog). Keeping the harness vocabulary (Workspace / SessionHeader) here,
 * isolated from the HTTP + WebSocket layer, is what lets the server be tested
 * without booting the real harness (tests inject a fake `loadWorkspaces`),
 * mirroring model-list.ts one-for-one.
 */

/** One workspace row served over /api/workspaces, driving the dropdown. */
export interface WorkspaceOption {
	/** Stable registry id (generated uuid). */
	readonly id: string;
	/** Canonical directory path; the run's workspace. */
	readonly path: string;
	/** Display title shown in the dropdown. */
	readonly title: string;
	/**
	 * Newest-session creation timestamp (Unix epoch milliseconds) among the
	 * workspace's sessions, used to preselect the most recently used
	 * workspace. Omitted when the workspace has no sessions.
	 */
	readonly newestSessionAt?: number;
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
 * Build the workspace list for the server from the shared registry + session
 * store. Each row carries the newest session's creation timestamp so the page
 * can preselect the most recently used workspace (read-only: no registry or
 * session mutation anywhere on this path).
 */
export async function convertWorkspaceList(
	registry: WorkspaceRegistryLike,
	sessions: SessionStoreLike,
): Promise<readonly WorkspaceOption[]> {
	const headers = await sessions.list();
	const createdAt = new Map<string, number>();
	for (const header of headers) {
		const current = createdAt.get(header.id);
		if (current === undefined || header.createdAt > current) {
			createdAt.set(header.id, header.createdAt);
		}
	}
	return registry.list().map((workspace) => {
		let newest: number | undefined;
		for (const sessionId of workspace.sessionIds) {
			const timestamp = createdAt.get(sessionId);
			if (
				timestamp !== undefined &&
				(newest === undefined || timestamp > newest)
			) {
				newest = timestamp;
			}
		}
		return {
			id: workspace.id,
			path: workspace.path,
			title: workspace.title,
			newestSessionAt: newest,
		};
	});
}
