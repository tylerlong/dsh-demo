/**
 * workspace.ts — resolving a run workspace to a canonical existing folder.
 *
 * A run workspace is a folder the run's agents (orchestrator and both workers)
 * may read for context (parent ticket #9). A submitted workspace path may be
 * absolute or relative; relative paths resolve against the server working
 * directory (process.cwd()). The harness-backed run factory (real-run-
 * factory.ts) uses this resolver as defense-in-depth validation of the
 * submitted path — the page's dropdown only offers existing canonical folders
 * (workspace-list.ts), but a folder removed after load must still fail fast.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a workspace path to its canonical existing directory, or undefined
 * when it is not an existing folder. Relative paths resolve against the
 * server working directory; the result is realpath-canonicalized.
 */
export function resolveWorkspace(path: string): string | undefined {
	// An empty workspace must fail (no implicit folder), not silently resolve
	// to the server working directory.
	if (path.trim() === "") {
		return undefined;
	}
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
