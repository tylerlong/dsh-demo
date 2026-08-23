import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "web/src/**/*.test.tsx"],
		// The web component tests run in a DOM-like environment (jsdom, opted
		// in per file) and load jest-dom matchers + per-test cleanup from the
		// web test setup; the server suites stay in the default node
		// environment with explicit imports.
		setupFiles: ["web/src/test-setup.ts"],
	},
});
