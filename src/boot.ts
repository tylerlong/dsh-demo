/**
 * boot.ts — shared standalone boot for the harness-workflow server.
 *
 * harness-workflow composes the full DSH harness tree itself through the public
 * `boot()` API from `@deepseek-ai/dsh-app-boot` instead of being a plugin
 * mounted by the `dsh` CLI. This is the server's only cross-cutting harness
 * dependency (see serve.ts).
 *
 * Boot recipe:
 *   - resolve the `@deepseek-ai/dsh-base` bundle from the DSH installation
 *     anchor (its patch lists the full base plugin set),
 *   - load that bundle's overlay patches, then mount the shared storage stack
 *     (storage, storage-json, storage-domain, workspace) — the same rows the
 *     web-app bundle composes — so `ctx.workspaceRegistry` reads DSH web's
 *     workspace table (`$DSH_HOME/storages`),
 *   - boot an empty root config with `bareModuleBaseUrl` pointed at the DSH
 *     monorepo's pnpm virtual store, so every `@deepseek-ai/*` plugin
 *     specifier resolves without a profile directory or the home flat
 *     fallback,
 *   - provide `cmdlineArgs` + `appExit` (what the CLI would provide).
 *
 * Every location defaults to the SHARED harness home (`~/.dsh/settings.yaml`,
 * `~/.dsh/.credentials.yaml`, `~/.dsh/sessions`), so harness-workflow shares
 * settings, the session store, and the workspace catalog with DSH web.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { z } from "zod";

/** This project's root directory (parent of src/). */
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The DSH installation anchor: the CLIs package.json, from which every
 * `@deepseek-ai/*` in-box package (including `@deepseek-ai/dsh-base`)
 * resolves through the normal node_modules walk at that anchor.
 */
const INSTALL_ANCHOR = fileURLToPath(
	new URL("../../deepseek-harness/apps/cli/package.json", import.meta.url),
);

/** The DSH monorepo root, whose pnpm virtual store resolves every plugin. */
const DSH_ROOT = fileURLToPath(
	new URL("../../deepseek-harness/", import.meta.url),
);

/** An empty plugin list; the tree is composed solely from the bundle patches. */
const ROOT_CONFIG_PATH = fileURLToPath(
	new URL("../root.cordis.yml", import.meta.url),
);

/**
 * Overlay that mounts the shared storage stack (storage, storage-json,
 * storage-domain, workspace) — the same rows the web-app bundle composes — so
 * `ctx.workspaceRegistry` reads the same workspace table as DSH web.
 */
const STORAGE_PATCH_PATH = join(PROJECT_ROOT, "storage.cordis.patch.yml");

/** Boot the full base harness tree and return the live context. */
export async function bootHarness(
	args: readonly string[] = [],
): Promise<Context> {
	// Resolve the base bundle package from the DSH installation anchor.
	const installRequire = createRequire(INSTALL_ANCHOR);
	const basePackageJson = installRequire.resolve(
		"@deepseek-ai/dsh-base/package.json",
	);
	const baseDir = dirname(basePackageJson);
	const baseManifest = JSON.parse(readFileSync(basePackageJson, "utf8")) as {
		dsh: { bundle: { patch: string } };
	};
	const basePatch = join(baseDir, baseManifest.dsh.bundle.patch);
	const patches = [
		...loadOverlayPatches("harness-workflow", basePatch),
		...loadOverlayPatches("harness-workflow", STORAGE_PATCH_PATH),
	];

	// Resolve every bare `@deepseek-ai/*` plugin specifier from the DSH
	// monorepo's pnpm virtual store — no profile directory, no home flat
	// fallback.
	const bareBase = pathToFileURL(
		join(DSH_ROOT, "node_modules", ".pnpm", "node_modules"),
	).href;

	let ctx: Context | undefined;
	const tree = await boot(
		"harness-workflow",
		ROOT_CONFIG_PATH,
		patches,
		(host) => {
			provideCmdline(host, {
				args,
				exit: (code) =>
					void ctx?.fiber.dispose().then(() => process.exit(code)),
			});
		},
		bareBase,
	);
	ctx = tree;
	registerSessionListMetadata(tree);
	return tree;
}

/**
 * The sessionListMetadata projection state: whether the checkpoint prefix
 * contains no turn/start event, and the latest user-origin message time.
 * Mirrors DSH web's SessionListMetadata (api-proxy sessions.ts).
 */
interface SessionListMetadataState {
	readonly blank: boolean;
	readonly lastPromptAt: number | null;
}

/** One committed session event, structurally (the shared store's event shape). */
interface SessionEventLike {
	readonly type: string;
	readonly time: number;
	readonly data: unknown;
}

/** The narrow slice of the projection registry this boot needs. */
interface SessionProjectionRegistryLike {
	register(definition: {
		readonly key: string;
		readonly stateSchema: { parse(value: unknown): unknown };
		init(): unknown;
		apply(state: unknown, event: unknown): unknown;
		readonly wire?: {
			readonly viewSchema: { parse(value: unknown): unknown };
			view(state: unknown): unknown;
		};
		readonly stateVersion: number;
	}): () => void;
}

/**
 * Register the `sessionListMetadata` projection unit, mirroring DSH web's
 * api-proxy registration (api-proxy.ts:1231-1241). The projection cache's
 * `cachedSnapshot` serves `sessionListMetadata` (`{blank, lastPromptAt}`)
 * only after this unit is registered — mounting the cache alone omits it even
 * though the row exists in the cache file. `title` comes free from the base
 * bundle's session-title row.
 *
 * Registered here, read-only: the unit only advances by committed events
 * (which this process never writes); `cachedSnapshot` reads the stored row.
 */
function registerSessionListMetadata(ctx: Context): void {
	const registry = ctx.get("sessionProjections") as
		| SessionProjectionRegistryLike
		| undefined;
	if (registry === undefined) {
		// The base bundle always composes the projection registry; if it is
		// ever absent, the cache face simply serves no sessionListMetadata.
		return;
	}
	registry.register({
		key: "sessionListMetadata",
		stateSchema: z.object({
			blank: z.boolean(),
			lastPromptAt: z.number().nullable(),
		}),
		init: () => ({ blank: true, lastPromptAt: null }),
		apply: applySessionListMetadata,
		wire: {
			viewSchema: z.object({
				blank: z.boolean(),
				lastPromptAt: z.number().nullable(),
			}),
			view: (state) => state,
		},
		stateVersion: 1,
	});
}

/** Advance the sessionListMetadata hint by one committed event. */
function applySessionListMetadata(
	state: SessionListMetadataState,
	event: SessionEventLike,
): SessionListMetadataState {
	const blank = state.blank && event.type !== "turn/start";
	const lastPromptAt =
		event.type === "user/message" &&
		isRecord(event.data) &&
		isRecord(event.data.source) &&
		event.data.source.kind === "user"
			? event.time
			: state.lastPromptAt;
	return blank === state.blank && lastPromptAt === state.lastPromptAt
		? state
		: { blank, lastPromptAt };
}

/** Narrow an unknown value to a plain record, or undefined otherwise. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
