/**
 * vite.config.ts — the harness-workflow frontend build and dev proxy.
 *
 * The React single-page application is built with Vite (root index document
 * at web/index.html) and styled with Tailwind CSS v4 via its Vite plugin, so
 * the stylesheet is a single `@import "tailwindcss"` entry with no separate
 * Tailwind config file. The build output lands in web/dist, which the server
 * (src/server.ts) serves as a generic static file server (ticket #31).
 *
 * Development (ticket #34) is one command: `pnpm dev` runs the backend and
 * this dev server together (concurrently). The dev server proxies the API
 * routes (/api/*) and the WebSocket endpoint (the shared WS_PATH) to the
 * backend, so the browser talks to one origin and gets hot reload. The proxy
 * target honors the same HARNESS_WORKFLOW_PORT override the backend reads.
 * Production serving is unchanged: `pnpm serve` builds then serves.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { WS_PATH } from "../shared/protocol.ts";

/** The backend port the dev proxy forwards to; same override serve.ts reads. */
const BACKEND_PORT = Number(process.env.HARNESS_WORKFLOW_PORT ?? 4173);

/**
 * The dev proxy map: the API routes and the WebSocket endpoint, forwarded to
 * the backend so the browser talks to one origin. Exported so the dev-proxy
 * test exercises the same proxy the dev command uses, pointed at a test
 * backend on a random port.
 */
export function devProxy(
	backendPort: number,
): Record<string, string | ProxyOptions> {
	return {
		"/api": {
			target: `http://127.0.0.1:${backendPort}`,
			changeOrigin: true,
		},
		[WS_PATH]: {
			target: `ws://127.0.0.1:${backendPort}`,
			ws: true,
		},
	};
}

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		// Bind the dev server to IPv4 localhost explicitly: the default
		// `localhost` host resolves IPv6-first on some machines (notably
		// GitHub Actions runners), which makes the dev origin unreachable at
		// the 127.0.0.1 address the backend and the dev-proxy test use.
		host: "127.0.0.1",
		proxy: devProxy(BACKEND_PORT),
	},
});
