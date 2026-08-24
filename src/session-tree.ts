/**
 * session-tree.ts — the read-only shared-store session-tree seam (ticket #38).
 *
 * The session browser left panel lists the workspaces DSH web owns, each
 * expandable to its sessions, read from the shared workspace registry
 * (ctx.workspaceRegistry) and the shared session store
 * (ctx.sessionPersistence). This module is the thin adapter from those
 * harness entities to the neutral two-level tree shape the server serves over
 * GET /api/sessions (parent ticket #44, child ticket #45): workspaces with
 * their sessions, each session carrying a readable label — its stored
 * title from the store projection read face when one exists, else a minimal
 * placeholder — plus updatedAt for recency.
 *
 * The tree mirrors DSH web grouped Updated view exactly:
 *   - workspaces appear in the durable registry order (registry.list()), the
 *     same order DSH web derives from the workspace domain table — never
 *     re-sorted by date;
 *   - only top-level conversations appear: origin subagent children and
 *     blank sessions (no turn ever ran) are filtered out, matching DSH
 *     web sessionVisible;
 *   - sessions within a workspace are ordered by updatedAt descending
 *     (newest last-activity first, ties by id like DSH web byRecency) and
 *     capped at the top 5 per workspace, matching DSH web COLLAPSED_SESSION_LIMIT.
 *
 * The label, origin, blank, and updatedAt come from the injected store
 * slice already-available fields — the fold happens in the loader, no
 * event-log scanning here. harness-workflow is strictly read-only over either
 * service: it only calls registry.list() and sessionPersistence.list(), never
 * a mutation (no create / delete / insertBefore / attachSession / setTitle /
 * archiveSession — DSH web owns the catalog). Keeping the harness vocabulary
 * here, isolated from the HTTP + WebSocket layer, is what lets the server be
 * tested without booting the real harness (tests inject a fake loadSessions),
 * mirroring model-list.ts one-for-one. This seam supersedes the flat
 * workspace dropdown seam (workspace-list.ts, ticket #19).
 */

/** The top-N most-recent sessions shown per workspace (ticket #45). */
export const TOP_SESSIONS_PER_WORKSPACE = 5; // DSH web COLLAPSED_SESSION_LIMIT

/**
 * One session row under a workspace in the tree.
 */
export interface SessionRow {
	/** The session's id. */
	readonly id: string;
	/**
	 * The session's display label: its stored title when one is set, else the
	 * workspace folder basename, else the raw id — DSH web's displayTitleOf.
	 * There is no "Untitled session" placeholder.
	 */
	readonly label: string;
	/** Unix epoch milliseconds of last activity (max(createdAt, last user prompt), matching DSH web updatedAt). */
	readonly updatedAt: number;
}

/** One workspace node in the two-level tree. */
export interface WorkspaceNode {
	/** Stable registry id (generated uuid). */
	readonly id: string;
	/** Canonical directory path. */
	readonly path: string;
	/** Display title. */
	readonly title: string;
	/** The workspace's sessions, ordered by updatedAt desc, capped at TOP_SESSIONS_PER_WORKSPACE. */
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
	/** Registry-global archive set: sessions hidden from every grouping surface. */
	readonly archivedSessionIds: readonly string[];
}

/**
 * The narrow slice of the shared session store this adapter needs. Each
 * header exposes the already-available fields the enriched tree requires: the
 * session's updatedAt (folded in the loader, matching DSH web updatedAt), its
 * origin marker (subagent children are filtered out), its blank marker (a
 * session with no turn ever ran, matching DSH web sessionVisible), its stored
 * label (the store's title projection read face) when one is set, and its cwd
 * (the label fallback's folder basename, matching DSH web displayTitleOf).
 */
export interface SessionStoreLike {
	/** Lightweight listing from metadata; headers carry updatedAt, origin, blank, label, cwd. */
	list(): Promise<
		readonly {
			readonly id: string;
			readonly updatedAt: number;
			readonly origin?: "subagent";
			readonly blank?: boolean;
			readonly label?: string;
			readonly cwd?: string;
		}[]
	>;
}

/** The folder basename of a cwd (DSH web workspaceTitleOf), or undefined. */
function cwdBasename(cwd: string | undefined): string | undefined {
	if (cwd === undefined || cwd === "") return undefined;
	const base = cwd
		.replace(/[/\\]+$/, "")
		.split(/[/\\]/)
		.pop();
	return base === undefined || base === "" ? undefined : base;
}

/**
 * Build the session tree for the server from the shared registry + session
 * store, mirroring DSH web grouped Updated view. Workspaces keep the durable
 * registry order; within each, sessions (non-subagent, non-blank, non-archived)
 * are ordered by updatedAt descending (ties by id, like DSH web byRecency) and
 * capped at TOP_SESSIONS_PER_WORKSPACE. Each row labels by stored title, else
 * workspace folder basename, else id (DSH web displayTitleOf). Strictly
 * read-only: only registry.list(), registry.archivedSessionIds, and
 * sessions.list(), never a mutation. Sessions listed by the registry but
 * absent from the store are omitted — the store is the source of the
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
	// Workspaces keep the durable registry order (registry.list() returns the
	// workspaceIds sequence) — never re-sorted by date, matching DSH web.
	const workspaces = registry.list();
	const archived = new Set(registry.archivedSessionIds);
	return workspaces.map((workspace) => {
		// Only top-level, non-blank, non-archived conversations are shown:
		// subagent children (the lane workers every run spawns), blank sessions
		// (no turn ever ran), and archived sessions never appear in the panel.
		// This drops every blank session — unlike DSH web's sessionVisible,
		// which keeps the current/provisional blank "New Session" row, because
		// this read-only listing has no such row of its own; the filter's shape
		// otherwise matches sessionVisible.
		const rows: SessionRow[] = [];
		for (const sessionId of workspace.sessionIds) {
			const header = byId.get(sessionId);
			if (header === undefined) {
				// Listed by the registry but absent from the store: omitted.
				continue;
			}
			if (
				header.origin === "subagent" ||
				header.blank ||
				archived.has(sessionId)
			) {
				continue;
			}
			rows.push({
				id: sessionId,
				label: header.label ?? cwdBasename(header.cwd) ?? sessionId,
				updatedAt: header.updatedAt,
			});
		}
		// Sessions ordered by last updated (updatedAt desc), ties by id — the
		// same byRecency comparator DSH web applies in its Updated view.
		rows.sort((a, b) =>
			b.updatedAt - a.updatedAt !== 0
				? b.updatedAt - a.updatedAt
				: a.id < b.id
					? -1
					: 1,
		);
		return {
			id: workspace.id,
			path: workspace.path,
			title: workspace.title,
			sessions: rows.slice(0, TOP_SESSIONS_PER_WORKSPACE),
		};
	});
}
