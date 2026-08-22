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
 *   - append a LOCAL patch layer that redirects every harness-home read to a
 *     project-local file/dir (settings.yaml, .credentials.yaml, sessions,
 *     agent instructions, skills, attachments, shell env) — so nothing under
 *     `~/.dsh` is read at all,
 *   - boot an empty root config with `bareModuleBaseUrl` pointed at the DSH
 *     monorepo's pnpm virtual store, so every `@deepseek-ai/*` plugin
 *     specifier resolves without a profile directory or the home flat
 *     fallback,
 *   - provide `cmdlineArgs` + `appExit` (what the CLI would provide).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

/**
 * Local patch layer: id-targeted config overrides that redirect every
 * harness-home read to a project-local location. The loader applies these
 * after the base bundle's patches (last write wins per row), so the tree
 * never reads `~/.dsh` — only this project's files.
 */
function localPatches(): Array<{
	id: string;
	config: Record<string, string | number>;
}> {
	return [
		// User-settings document.
		{ id: "settings", config: { path: join(PROJECT_ROOT, "settings.yaml") } },
		// Credential store (the OpenRouter key).
		{
			id: "credentials",
			config: { path: join(PROJECT_ROOT, ".credentials.yaml") },
		},
		// Session logs.
		{
			id: "session-persistence-jsonl",
			config: { root: join(PROJECT_ROOT, ".dsh-sessions") },
		},
		// User-global AGENTS.md (absent here → no user-global instructions).
		// NOTE: a patch replaces the row's whole config, so the base row's
		// required `maxBytes` must be restated.
		{
			id: "agent-instructions",
			config: { maxBytes: 65536, dshHome: PROJECT_ROOT },
		},
		// User skills (absent here → no user skills).
		{
			id: "skill-filesystem",
			config: { dshHome: PROJECT_ROOT },
		},
		// Image attachments.
		{
			id: "attachment-local",
			config: { dshHome: PROJECT_ROOT },
		},
		// DSH_HOME exposed to subprocesses → the project root.
		{
			id: "shell-env",
			config: { dshHome: PROJECT_ROOT },
		},
	];
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
		...localPatches(),
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
