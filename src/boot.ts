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
 *   - boot an empty root config with `bareModuleBaseUrl` pointed at the
 *     harness-home flat module fallback, so every `@deepseek-ai/*` plugin
 *     specifier resolves without a profile directory,
 *   - provide `cmdlineArgs` + `appExit` (what the CLI would provide).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import {
	boot,
	healProfilesModuleFallback,
	loadOverlayPatches,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/**
 * The DSH installation anchor: the CLIs package.json, from which every
 * `@deepseek-ai/*` in-box package (including `@deepseek-ai/dsh-base`)
 * resolves through the normal node_modules walk at that anchor.
 */
const INSTALL_ANCHOR = fileURLToPath(
	new URL("../../deepseek-harness/apps/cli/package.json", import.meta.url),
);

/** An empty plugin list; the tree is composed solely from the bundle patches. */
const ROOT_CONFIG_PATH = fileURLToPath(
	new URL("../root.cordis.yml", import.meta.url),
);

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
	const patches = loadOverlayPatches("dsh-demo", basePatch);

	// Resolve every bare `@deepseek-ai/*` plugin specifier from the harness
	// home's flat module fallback (`~/.dsh/profiles/node_modules`), which heals
	// to mirror the DSH installation's resolvable closure. This removes the
	// need for any profile directory: no profile is read — only the shared
	// flat fallback + settings.yaml.
	healProfilesModuleFallback(INSTALL_ANCHOR);
	const bareBase = pathToFileURL(
		join(resolveDshHome(), "profiles", "node_modules"),
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
