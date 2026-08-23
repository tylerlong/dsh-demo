/**
 * workspace.ts — resolving a run workspace to a canonical existing folder.
 *
 * A run workspace is a folder the run's agents (orchestrator and both workers)
 * may read for context (parent ticket #9). A submitted workspace path may be
 * absolute or relative; relative paths resolve against the server working
 * directory (process.cwd()). Both the harness-backed run factory (real-run-
 * factory.ts) and the server workspace-existence endpoint (server.ts) share
 * this resolver, so the run rejects a missing folder exactly when the page's
 * existence check reports it missing.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a workspace path to its canonical existing directory, or undefined
 * when it is not an existing folder. Relative paths resolve against the
 * server working directory; the result is realpath-canonicalized.
 */
export function resolveWorkspace(path: string): string | undefined {
	try {
		const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
		const canonical = realpathSync(absolute);
		if (statSync(canonical).isDirectory()) {
			return canonical;
		}
	} catch {
		// Not a resolvable existing directory.
	}
	return undefined;
}

/** Whether a path resolves to an existing folder (the page's existence check). */
export function workspaceExists(path: string): boolean {
	return resolveWorkspace(path) !== undefined;
}
