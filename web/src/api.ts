/**
 * api.ts — the harness-workflow client API.
 *
 * The run configuration form's model and workspace selectors populate at
 * runtime from the server's model-list and workspace-list endpoints (ticket
 * #32): GET /api/models returns the configured model list plus the agreed
 * default selection, and GET /api/workspaces returns the shared workspace
 * catalog rows. These thin fetch wrappers mirror the shapes the server serves
 * (see src/model-list.ts and src/workspace-list.ts), so the client and the
 * server agree on the dropdown contract.
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

/** One workspace row served by GET /api/workspaces. */
export interface WorkspaceOption {
	/** Stable registry id (generated uuid). */
	readonly id: string;
	/** Canonical directory path; the run's workspace. */
	readonly path: string;
	/** Display title shown in the dropdown. */
	readonly title: string;
	/**
	 * Newest-session creation timestamp (Unix epoch milliseconds), used to
	 * preselect the most recently used workspace. Omitted when the workspace
	 * has no sessions.
	 */
	readonly newestSessionAt?: number;
}

/** Fetch the configured model list and its agreed defaults from /api/models. */
export async function fetchModels(): Promise<ModelsResponse> {
	const res = await fetch("/api/models");
	if (!res.ok) {
		throw new Error(`GET /api/models failed with status ${res.status}`);
	}
	return (await res.json()) as ModelsResponse;
}

/** Fetch the shared workspace catalog rows from /api/workspaces. */
export async function fetchWorkspaces(): Promise<readonly WorkspaceOption[]> {
	const res = await fetch("/api/workspaces");
	if (!res.ok) {
		throw new Error(`GET /api/workspaces failed with status ${res.status}`);
	}
	return (await res.json()) as WorkspaceOption[];
}
