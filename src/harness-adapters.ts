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
import {
	convertSessionTranscript,
	type TranscriptStoreLike,
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
 * workspace registry and session store (the storage stack boot.ts mounts),
 * pinned to the session-tree seam shapes. Strictly read-only — only
 * `registry.list()` and `sessionPersistence.list()`, never a mutation. A read
 * failure resolves to [] and logs, matching serve.ts today.
 */
export function loadSessionsFromContext(
	ctx: Context,
): () => Promise<readonly WorkspaceNode[]> {
	const registry: WorkspaceRegistryLike = service(ctx, "workspaceRegistry");
	const sessions: SessionStoreLike = service(ctx, "sessionPersistence");
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
 * and logs, matching serve.ts today. Live lane windows are supplied by the
 * caller when our own run is active.
 */
export function loadTranscriptFromContext(
	ctx: Context,
): (sessionId: string) => Promise<SessionTranscript> {
	const store: TranscriptStoreLike = service(ctx, "sessionPersistence");
	return (sessionId) =>
		convertSessionTranscript(store, sessionId).catch((error) => {
			console.error(
				`harness-workflow: failed to read session ${sessionId} transcript: ${error instanceof Error ? error.message : error}`,
			);
			return { primary: { sessionId, lines: [] }, lanes: [] };
		});
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
