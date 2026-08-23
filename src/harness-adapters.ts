/**
 * harness-adapters.ts — typed wiring from the booted harness context to the
 * server's structural seams (model-list.ts, workspace-list.ts).
 *
 * serve.ts boots the shared harness tree and starts the server; the two
 * loaders the server needs come straight off that booted context:
 *
 *   - `ctx.llm` — the typed llm registry (`LlmRuntime`, structurally an
 *     {@link LlmLike}) — feeds the /api/models dropdown loader directly, with
 *     no cast: the `@deepseek-ai/dsh-llm` context augmentation is real and the
 *     runtime `listProviders` / `listModels` signatures match the seam.
 *   - the workspace registry and session store are read by name off the same
 *     context (the shared storage stack boot.ts mounts) and pinned to the
 *     workspace-seam shapes (`WorkspaceRegistryLike` / `SessionStoreLike`), so
 *     the product path carries no `as unknown as` cast.
 *
 * The structural seams are unchanged: server tests inject fake loaders
 * (`loadModels` / `loadWorkspaces`) directly and never reach this module.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { ModelOption } from "./model-list.ts";
import { convertLlmModels } from "./model-list.ts";
import type { WorkspaceOption } from "./workspace-list.ts";
import {
	convertWorkspaceList,
	type SessionStoreLike,
	type WorkspaceRegistryLike,
} from "./workspace-list.ts";

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
				`dsh-compare: failed to read the configured model list: ${error instanceof Error ? error.message : error}`,
			);
			return [];
		});
}

/**
 * The /api/workspaces loader supplied from the booted context: the shared
 * workspace registry and session store (the storage stack boot.ts mounts),
 * pinned to the workspace-seam shapes. A read failure resolves to [] and logs,
 * matching serve.ts today.
 */
export function loadWorkspacesFromContext(
	ctx: Context,
): () => Promise<readonly WorkspaceOption[]> {
	const registry: WorkspaceRegistryLike = service(ctx, "workspaceRegistry");
	const sessions: SessionStoreLike = service(ctx, "sessionPersistence");
	return () =>
		convertWorkspaceList(registry, sessions).catch((error) => {
			console.error(
				`dsh-compare: failed to read the shared workspace list: ${error instanceof Error ? error.message : error}`,
			);
			return [];
		});
}
