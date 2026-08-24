import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * harness-workflow end-to-end tests.
 *
 * The webServer boots the REAL app (pnpm serve → the harness-backed server on
 * 127.0.0.1:4173), so these tests exercise the actual product: page shell,
 * /api/models dropdowns, the WebSocket run protocol, and the harness-backed
 * run factory. They need the local harness checkout (../deepseek-harness) and
 * real model credentials — run them locally, not in CI.
 *
 * ISOLATED STORE: the suite never touches the real harness home (~/.dsh).
 * The webServer command FIRST runs seed-isolated-home.ts to build a throwaway
 * home at test/e2e/.home (settings + credentials copied from ~/.dsh, plus one
 * fixture workspace/session created through DSH's own services), THEN boots
 * the server with DSH_HOME pointed there. Chaining the seed into the command
 * (rather than a separate globalSetup) guarantees the server never boots
 * against an unseeded home, so its store reads land on the seeded fixture.
 * Every write the tests cause — resuming the fixture session, appending turns,
 * projection-cache checkpoints — lands in the isolated home, never in the
 * store DSH web owns.
 */
export default defineConfig({
	testDir: "test/e2e",
	timeout: 180_000,
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: "http://127.0.0.1:4173",
		headless: true,
	},
	webServer: {
		command:
			"pnpm exec tsx --expose-internals test/e2e/seed-isolated-home.ts && pnpm serve",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
		timeout: 90_000,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			DSH_HOME: fileURLToPath(new URL("./test/e2e/.home", import.meta.url)),
		},
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
