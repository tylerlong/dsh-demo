/**
 * harness-adapters.ts — typed wiring from the booted harness context to the
 * server's structural seams (model-list.ts, session-tree.ts,
 * session-transcript.ts).
 *
 * serve.ts boots the shared harness tree and starts the server; the loaders
 * the server needs come straight off that booted context:
 *
 *   - `ctx.llm` — the typed llm registry (`LlmRuntime`, structurally an
 *     {@link LlmLike}) — feeds the /api/models dropdown loader directly, with
 *     no cast: the `@deepseek-ai/dsh-llm` context augmentation is real and the
 *     runtime `listProviders` / `listModels` signatures match the seam.
 *   - the workspace registry and session store are read by name off the same
 *     context (the shared storage stack boot.ts mounts) and pinned to the
 *     session-browser seam shapes (`WorkspaceRegistryLike` / `SessionStoreLike`
 *     for the tree, `TranscriptStoreLike` for the transcript read), so the
 *     product path carries no `as unknown as` cast.
 *   - session labels (ticket #45) come from the store's title read face: the
 *     unified session-query service (`ctx.sessionQuery`, a base-bundle row
 *     that stays mounted for exact reads and titles) folds each session's
 *     stored title, which the tree adapter surfaces as the row's `label`.
 *     The title projection source is the same `session-title` +
 *     `session-projection` store harness-workflow already boots.
 *
 * The structural seams are unchanged: server tests inject fake loaders
 * (`loadModels` / `loadSessions` / `loadTranscript`) directly and never reach
 * this module.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { liveLanesFor } from "./live-lanes.ts";
import type { ModelOption } from "./model-list.ts";
import { convertLlmModels } from "./model-list.ts";
import type { SessionTranscript } from "./session-transcript.ts";
import {
	convertSessionTranscript,
	type TranscriptStoreLike,
	type TranscriptWindow,
} from "./session-transcript.ts";
import type { WorkspaceNode } from "./session-tree.ts";
import {
	convertSessionTree,
	type SessionStoreLike,
	type WorkspaceRegistryLike,
} from "./session-tree.ts";

/**
 * Pin one named context service to a declared shape. `ctx.get` is untyped
 * (`any`); this is the single place that narrows it, so the loaders below read
 * off the booted context without reach-through casts.
 */
function service<T>(ctx: Context, name: string): T {
	return ctx.get(name) as T;
}

/** The narrow slice of the shared session store this loader needs: a header
 * listing with each session id, createdAt, cwd (the cache identity witness),
 * and origin marker, plus the per-session event read the recency fold needs
 * (matching DSH web, which derives updatedAt and blank from each session
 * events). */
export interface SessionPersistenceLike {
	list(): Promise<
		readonly {
			readonly id: string;
			readonly createdAt: number;
			readonly cwd?: string;
			readonly origin?: "subagent";
		}[]
	>;
	/** Read one session committed event log (the fold in the loader uses it). */
	inspect(id: string): Promise<{
		readonly meta: { readonly id: string };
		readonly events: readonly {
			readonly type: string;
			readonly time: number;
			readonly data: unknown;
		}[];
	}>;
}

/**
 * The narrow slice of the projection cache this loader needs: the zero-I/O
 * per-session read of the stored `title` and `sessionListMetadata` values
 * (matching DSH web's sessionProjectionCache.cachedSnapshot). The header
 * passed in is the identity witness — the cache serves a row only when its
 * bound createdAt/cwd match the caller's header, so a recreated id or a
 * swapped store can never surface an unrelated log's values.
 */
export interface SessionProjectionCacheLike {
	cachedSnapshot(meta: {
		readonly id: string;
		readonly createdAt: number;
		readonly cwd?: string;
	}):
		| {
				readonly asOfSeq: number;
				readonly values: {
					readonly title?: string | null;
					readonly sessionListMetadata?: {
						readonly blank: boolean;
						readonly lastPromptAt: number | null;
					};
				};
		  }
		| undefined;
}

/** Narrow an unknown value to a plain record, or undefined otherwise. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Fold one session events into the two list facts DSH web derives from them
 * (api-proxy applySessionListMetadata / sessionListMetadata):
 *   - blank: no turn ever started (a turn/start event flips it false);
 *   - lastPromptAt: the time of the last user-origin user/message.
 * updatedAt is then max(createdAt, lastPromptAt). Mirrors DSH web so the
 * tree matches its grouped Updated view.
 */
function sessionListFold(
	session: { readonly createdAt: number },
	events: readonly {
		readonly type: string;
		readonly time: number;
		readonly data: unknown;
	}[],
): { readonly blank: boolean; readonly updatedAt: number } {
	let blank = true;
	let lastPromptAt = 0;
	for (const event of events) {
		if (event.type === "turn/start") {
			blank = false;
			continue;
		}
		if (
			event.type === "user/message" &&
			isRecord(event.data) &&
			isRecord(event.data.source) &&
			event.data.source.kind === "user"
		) {
			lastPromptAt = event.time;
		}
	}
	return { blank, updatedAt: Math.max(session.createdAt, lastPromptAt) };
}

export interface SessionQueryLike {
	readTitleSnapshots(sessionIds: readonly string[]): Promise<
		readonly (
			| {
					readonly sessionId: string;
					readonly status: "fulfilled";
					readonly value: { readonly title?: { readonly title: string } };
			  }
			| { readonly sessionId: string; readonly status: "rejected" }
		)[]
	>;
}

/** Collect the stored title per session id from a title-snapshot batch. */
function labelsFromTitles(
	results: Awaited<ReturnType<SessionQueryLike["readTitleSnapshots"]>>,
): Map<string, string> {
	const labels = new Map<string, string>();
	for (const result of results) {
		if (result.status === "fulfilled") {
			const title = result.value.title;
			if (title !== undefined) {
				labels.set(result.sessionId, title.title);
			}
		}
	}
	return labels;
}

/**
 * The /api/models loader supplied from the booted context: the typed llm
 * registry (an {@link LlmLike}), listed over /api/models. A read failure
 * resolves to [] and logs rather than break the page, matching serve.ts today.
 */
export function loadModelsFromContext(
	ctx: Context,
): () => Promise<readonly ModelOption[]> {
	const llm: LlmRuntime = ctx.llm;
	return () =>
		convertLlmModels(llm).catch((error) => {
			console.error(
				`harness-workflow: failed to read the configured model list: ${error instanceof Error ? error.message : error}`,
			);
			return [];
		});
}

/**
 * The /api/sessions loader supplied from the booted context: the shared
 * workspace registry, session store (the storage stack boot.ts mounts), the
 * projection cache (boot.ts mounts + registers the sessionListMetadata unit),
 * and the title read face (ctx.sessionQuery), pinned to the session-tree seam
 * shapes. The store slice the seam consumes enriches each header with the
 * session's stored `label` from the projection cache's `title` value and its
 * `blank` + `updatedAt` from the cache's `sessionListMetadata` value, so the
 * seam filters/orders/truncates purely. Strictly read-only — only
 * `registry.list()`, `sessionPersistence.list()`, the cache's zero-I/O
 * `cachedSnapshot`, and (cache-miss fallback) the event fold + title read;
 * never a mutation. A read failure resolves to [] and logs, matching serve.ts
 * today.
 */
export function loadSessionsFromContext(
	ctx: Context,
): () => Promise<readonly WorkspaceNode[]> {
	const registry: WorkspaceRegistryLike = service(ctx, "workspaceRegistry");
	const persistence: SessionPersistenceLike = service(
		ctx,
		"sessionPersistence",
	);
	const cache: SessionProjectionCacheLike | undefined = service(
		ctx,
		"sessionProjectionCache",
	);
	const query: SessionQueryLike | undefined = service(ctx, "sessionQuery");
	const sessions: SessionStoreLike = {
		async list() {
			// Only the sessions the registry lists can ever appear in the tree (the
			// tree iterates workspace.sessionIds), so fold + title-read just those —
			// never the whole persisted corpus, which is far larger.
			const registryIds = new Set(
				registry.list().flatMap((workspace) => workspace.sessionIds),
			);
			const headers = (await persistence.list()).filter((header) =>
				registryIds.has(header.id),
			);
			// Recency + blank from the projection cache first: DSH web checkpoints
			// each session's title and sessionListMetadata into the shared cache,
			// and cachedSnapshot serves them with zero I/O (the header is the
			// identity witness). This is the same data DSH web's panel reads, so
			// the tree matches its grouped Updated view — including the live
			// session DSH web is actively writing, whose raw log the fold below
			// cannot read (its tail is mid-write).
			const cached = headers.map((header) => ({
				header,
				snapshot: cache?.cachedSnapshot(header),
			}));
			// Sessions the cache misses fall back to the event fold (matching DSH
			// web sessionListMetadata derivation from events) + the title read.
			const missing = cached
				.filter((entry) => entry.snapshot === undefined)
				.map((entry) => entry.header);
			const folds = await Promise.all(
				missing.map(async (h) => {
					try {
						const inspection = await persistence.inspect(h.id);
						const fold = sessionListFold(h, inspection.events);
						return { id: h.id, ...fold };
					} catch {
						// An unreadable session has no events to fold: treat as
						// non-blank with updatedAt = createdAt rather than drop it.
						return { id: h.id, blank: false, updatedAt: h.createdAt };
					}
				}),
			);
			const foldById = new Map(folds.map((fold) => [fold.id, fold]));
			const labels =
				query === undefined || missing.length === 0
					? new Map<string, string>()
					: labelsFromTitles(
							await query.readTitleSnapshots(missing.map((h) => h.id)),
						);
			return cached.map(({ header, snapshot }) => {
				if (snapshot !== undefined) {
					const metadata = snapshot.values.sessionListMetadata;
					const title = snapshot.values.title;
					return {
						id: header.id,
						createdAt: header.createdAt,
						updatedAt: Math.max(header.createdAt, metadata?.lastPromptAt ?? 0),
						blank: metadata?.blank ?? false,
						origin: header.origin,
						label: title ?? undefined,
					};
				}
				const fold = foldById.get(header.id);
				return {
					id: header.id,
					createdAt: header.createdAt,
					updatedAt: fold?.updatedAt ?? header.createdAt,
					blank: fold?.blank ?? false,
					origin: header.origin,
					label: labels.get(header.id),
				};
			});
		},
	};
	return () =>
		convertSessionTree(registry, sessions).catch((error) => {
			console.error(
				`harness-workflow: failed to read the shared session tree: ${error instanceof Error ? error.message : error}`,
			);
			return [];
		});
}

/**
 * The /api/sessions/:id/transcript loader supplied from the booted context:
 * the shared session store, pinned to the transcript-read seam shape. Strictly
 * read-only — only `store.inspect()` (child #46: no parentSession listing), never
 * a mutation. A read failure resolves to an empty transcript ([]-equivalent)
 * and logs, matching serve.ts today. The two live lane-worker windows of our
 * own in-progress run (registered by the run factory in live-lanes.ts) are
 * read alongside the primary, so a live run renders its two lanes while it
 * is active; with no live run the lanes stay empty.
 */
export function loadTranscriptFromContext(
	ctx: Context,
): (sessionId: string) => Promise<SessionTranscript> {
	const store: TranscriptStoreLike = service(ctx, "sessionPersistence");
	return async (sessionId) => {
		try {
			// Our own live run's lane-worker children supply the live lanes
			// (spec #44, User Story 8): read each live worker's store window the
			// same way the primary window is read, so the lane transcripts render
			// alongside the primary while the run is in progress. With no live
			// run for this session, the registry is empty and lanes stay [].
			const liveLaneRefs = liveLanesFor(sessionId);
			const liveLanes: TranscriptWindow[] = await Promise.all(
				liveLaneRefs.map(async (ref) => {
					const window = await convertSessionTranscript(
						store,
						ref.workerSessionId,
					);
					return {
						sessionId: ref.workerSessionId,
						lines: window.primary.lines,
					};
				}),
			);
			return await convertSessionTranscript(store, sessionId, liveLanes);
		} catch (error) {
			console.error(
				`harness-workflow: failed to read session ${sessionId} transcript: ${error instanceof Error ? error.message : error}`,
			);
			return { primary: { sessionId, lines: [] }, lanes: [] };
		}
	};
}

/**
 * The live session-store watcher supplied from the booted context (parent
 * ticket #37): register a listener on the shared session/event feed for one
 * session and call the callback whenever that session's store content advances
 * (an assistant chunk is the visible progress signal). Returns the disposer.
 * Strictly read-only — the listener never mutates the store.
 */
export function watchSessionFromContext(
	ctx: Context,
): (sessionId: string, onUpdate: () => void) => () => void {
	return (sessionId, onUpdate) => {
		// A watched session is live when it's the orchestrator of our own run:
		// identity of the session itself, or of any of its live lane-worker
		// children (which stream into their own child sessions during a run,
		// parent unless the primary is watched). Firing onUpdate for a child's
		// assistant chunk pushes the same session/updated for the watched
		// primary, so the panel re-reads the primary plus its live lanes
		// (spec #44, User Story 8) — no new push, no polling, read-only.
		const laneSessionIds = () =>
			new Set(liveLanesFor(sessionId).map((ref) => ref.workerSessionId));
		return ctx.on("session/event", (session, event) => {
			if (session.id !== sessionId && !laneSessionIds().has(session.id)) {
				return;
			}
			if (event.type === "assistant/chunk") {
				onUpdate();
			}
		});
	};
}
