import { defineConfig } from "@playwright/test";

/**
 * dsh-compare end-to-end tests.
 *
 * The webServer boots the REAL app (pnpm serve → the harness-backed server on
 * 127.0.0.1:4173), so these tests exercise the actual product: page shell,
 * /api/models dropdowns, the WebSocket run protocol, and the harness-backed
 * run factory. They need the local harness checkout (../deepseek-harness) and
 * the shared harness home (~/.dsh with model credentials) — run them locally,
 * not in CI.
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
		command: "pnpm serve",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
