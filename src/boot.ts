/**
 * boot.ts — shared standalone boot for the demo scripts.
 *
 * Both demos compose the full DSH harness tree themselves through the public
 * `boot()` API from `@deepseek-ai/dsh-app-boot` instead of being plugins
 * mounted by the `dsh` CLI. This is the ONLY cross-cutting dependency shared
 * by the two scripts.
 *
 * Boot recipe:
 *   - resolve the `@deepseek-ai/dsh-base` bundle from the DSH installation
 *     anchor (its patch lists the full base plugin set),
 *   - load that bundle's overlay patches,
 *   - read the optional project config file (`dsh-demo.config.json`) and, for
 *     every location it overrides, append an id-targeted patch redirecting
 *     that harness-home read to the configured path. With no config file (or
 *     an empty one) every location defaults to the SHARED harness home
 *     (`~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml`, `~/.dsh/sessions`),
 *     so the scripts share settings and the session store with the DSH web,
 *   - boot an empty root config with `bareModuleBaseUrl` pointed at the DSH
 *     monorepo's pnpm virtual store, so every `@deepseek-ai/*` plugin
 *     specifier resolves without a profile directory or the home flat
 *     fallback,
 *   - compose the shared storage stack (storage, storage-json, storage-domain,
 *     workspace) — the same rows the web-app bundle composes — so the shared
 *     workspace registry reads DSH web's workspace table (`$DSH_HOME/storages`),
 *   - provide `cmdlineArgs` + `appExit` (what the CLI would provide).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";

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

/** Optional project config file (`dsh-demo.config.json`). */
const CONFIG_PATH = join(PROJECT_ROOT, "dsh-demo.config.json");

/**
 * Overlay that mounts the shared storage stack (storage, storage-json,
 * storage-domain, workspace) — the same rows the web-app bundle composes — so
 * `ctx.workspaceRegistry` reads the same workspace table as DSH web.
 */
const STORAGE_PATCH_PATH = join(PROJECT_ROOT, "storage.cordis.patch.yml");

/**
 * Location overrides from `dsh-demo.config.json`. Every key is optional;
 * an absent key (or absent file) keeps the shared harness-home default.
 * A leading `~` expands to the OS home; other relative paths resolve
 * against the project root.
 */
export interface DemoConfig {
	/** Settings document; default: `$DSH_HOME/settings.yaml`. */
	settingsPath?: string;
	/** Credentials document; default: `$DSH_HOME/.credentials.yaml`. */
	credentialsPath?: string;
	/** Session store root; default: `$DSH_HOME/sessions`. */
	sessionsRoot?: string;
	/** Harness home for agent instructions / skills / attachments / shell env; default: `$DSH_HOME`. */
	dshHome?: string;
}

/** Read and validate the optional config file; an absent file is an empty config. */
function loadDemoConfig(): DemoConfig {
	let text: string;
	try {
		text = readFileSync(CONFIG_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`dsh-demo: failed to parse ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`dsh-demo: ${CONFIG_PATH} must be a JSON object`);
	}
	const config: DemoConfig = {};
	for (const key of [
		"settingsPath",
		"credentialsPath",
		"sessionsRoot",
		"dshHome",
	] as const) {
		const value = (parsed as Record<string, unknown>)[key];
		if (typeof value === "string" && value !== "") config[key] = value;
	}
	return config;
}

/**
 * Resolve a config path to an absolute path. A leading `~` (or `~/`) expands
 * to the OS home directory; any other relative path resolves against the
 * project root.
 */
function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(PROJECT_ROOT, path);
}

/**
 * Build the override patch layer from the config. Only keys explicitly set
 * in `dsh-demo.config.json` produce a patch; everything else keeps the
 * shared harness-home default. The loader applies these after the base
 * bundle's patches (last write wins per row).
 */
function overridePatches(config: DemoConfig): Array<{
	id: string;
	config: Record<string, string | number>;
}> {
	const patches: Array<{
		id: string;
		config: Record<string, string | number>;
	}> = [];
	if (config.settingsPath !== undefined) {
		patches.push({
			id: "settings",
			config: { path: expandPath(config.settingsPath) },
		});
	}
	if (config.credentialsPath !== undefined) {
		patches.push({
			id: "credentials",
			config: { path: expandPath(config.credentialsPath) },
		});
	}
	if (config.sessionsRoot !== undefined) {
		patches.push({
			id: "session-persistence-jsonl",
			config: { root: expandPath(config.sessionsRoot) },
		});
	}
	if (config.dshHome !== undefined) {
		const home = expandPath(config.dshHome);
		// agent-instructions' config is replaced wholesale, so the base row's
		// required `maxBytes` must be restated.
		patches.push({
			id: "agent-instructions",
			config: { maxBytes: 65536, dshHome: home },
		});
		patches.push({ id: "skill-filesystem", config: { dshHome: home } });
		patches.push({ id: "attachment-local", config: { dshHome: home } });
		patches.push({ id: "shell-env", config: { dshHome: home } });
	}
	return patches;
}

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
		...loadOverlayPatches("dsh-demo", basePatch),
		...overridePatches(loadDemoConfig()),
		...loadOverlayPatches("dsh-demo", STORAGE_PATCH_PATH),
	];

	// Resolve every bare `@deepseek-ai/*` plugin specifier from the DSH
	// monorepo's pnpm virtual store — no profile directory, no home flat
	// fallback.
	const bareBase = pathToFileURL(
		join(DSH_ROOT, "node_modules", ".pnpm", "node_modules"),
	).href;

	let ctx: Context | undefined;
	const tree = await boot(
		"dsh-demo",
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
	return tree;
}

/** Dispose the harness tree and exit with the given code. */
export async function shutdown(ctx: Context, code: number): Promise<never> {
	await ctx.fiber.dispose();
	process.exit(code);
}
