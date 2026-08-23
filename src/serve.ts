/**
 * serve.ts — run the dsh-compare server against the real harness.
 *
 * Boots the shared harness tree (src/boot.ts) and starts the HTTP + WebSocket
 * server (src/server.ts), wiring the /api/models dropdown source to the
 * harness's configured model list (the llm-pi-ai namespace) via the harness
 * llm registry. The run factory seam (src/run-factory.ts) is wired to the
 * harness-backed factory (src/real-run-factory.ts), so a manual smoke test
 * (boot server → connect → submit → watch two lanes → cancel) exercises the
 * real orchestration end to end (ticket #5).
 *
 * Run:  pnpm serve
 * Port: DSH_COMPARE_PORT env, default 4173.
 */
import { bootHarness } from "./boot.ts";
import { convertLlmModels, type LlmLike } from "./model-list.ts";
import { createRunFactory } from "./real-run-factory.ts";
import { startServer } from "./server.ts";
import {
	convertWorkspaceList,
	type SessionStoreLike,
	type WorkspaceRegistryLike,
} from "./workspace-list.ts";

/** Port for the server; override with DSH_COMPARE_PORT. */
const PORT = Number(process.env.DSH_COMPARE_PORT ?? 4173);

try {
	const ctx = await bootHarness();
	await ctx.get("loader")?.await();
	const llm = ctx.get("llm");
	const handle = await startServer({
		port: PORT,
		loadModels: () =>
			convertLlmModels(llm as unknown as LlmLike).catch((error) => {
				console.error(
					`dsh-compare: failed to read the configured model list: ${error instanceof Error ? error.message : error}`,
				);
				return [];
			}),
		// Production wires the seam to the shared workspace registry + session
		// store (read-only; the workspace catalog is DSH web's, ticket #19).
		loadWorkspaces: () =>
			convertWorkspaceList(
				ctx.get("workspaceRegistry") as unknown as WorkspaceRegistryLike,
				ctx.get("sessionPersistence") as unknown as SessionStoreLike,
			).catch((error) => {
				console.error(
					`dsh-compare: failed to read the shared workspace list: ${error instanceof Error ? error.message : error}`,
				);
				return [];
			}),
		// Production wires the seam to the harness-backed factory.
		startRun: createRunFactory(ctx),
	});

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`dsh-compare: received ${signal}, shutting down`);
		await handle.close();
		await ctx.fiber.dispose();
		process.exit(0);
	};
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
} catch (error) {
	console.error(
		`dsh-compare: ${error instanceof Error ? error.message : error}`,
	);
	process.exit(1);
}
