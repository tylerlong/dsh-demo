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
import type { ModelOption } from "./model-list.ts";
import { convertLlmModels } from "./model-list.ts";
import type { SessionTranscript } from "./session-transcript.ts";
import { liveLanesFor } from "./live-lanes.ts";
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

/** The narrow slice of the shared session store this loader needs: header
 * listing with each session's id, createdAt, and origin marker. */
export interface SessionPersistenceLike {
	list(): Promise<
		readonly {
			readonly id: string;
			readonly createdAt: number;
			readonly origin?: "subagent";
		}[]
	>;
}

/**
 * The narrow slice of the mounted session-query service the tree label read
 * needs: fold the stored title for each requested session id (live or
 * persisted), returning one per id. Failures stay per-session, so a session
 * with no readable title resolves absent and the tree falls back to the
 * placeholder.
 */
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
 * workspace registry, session store (the storage stack boot.ts mounts), and
 * title read face (ctx.sessionQuery), pinned to the session-tree seam shapes.
 * The store slice the seam consumes enriches each header with the session's
 * stored `label` from the title read face and its `origin` from the persisted
 * header, so the seam filters/orders/truncates purely. Strictly read-only —
 * only `registry.list()`, `sessionPersistence.list()`, and the title read;
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
	const query: SessionQueryLike | undefined = service(ctx, "sessionQuery");
	const sessions: SessionStoreLike = {
		async list() {
			const headers = await persistence.list();
			const labels =
				query === undefined
					? new Map<string, string>()
					: labelsFromTitles(
							await query.readTitleSnapshots(headers.map((h) => h.id)),
						);
			return headers.map((header) => ({
				id: header.id,
				createdAt: header.createdAt,
				origin: header.origin,
				label: labels.get(header.id),
			}));
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
					return { sessionId: ref.workerSessionId, lines: window.primary.lines };
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
	return (sessionId, onUpdate) =>
		ctx.on("session/event", (session, event) => {
			if (session.id !== sessionId) {
				return;
			}
			if (event.type === "assistant/chunk") {
				onUpdate();
			}
		});
}
