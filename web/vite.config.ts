/**
 * vite.config.ts — the harness-workflow frontend build.
 *
 * The React single-page application is built with Vite (root index document
 * at web/index.html) and styled with Tailwind CSS v4 via its Vite plugin, so
 * the stylesheet is a single `@import "tailwindcss"` entry with no separate
 * Tailwind config file. The build output lands in web/dist, which the server
 * (src/server.ts) serves as a generic static file server (ticket #31).
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
});
