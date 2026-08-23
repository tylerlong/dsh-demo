/**
 * dev-proxy.test.ts — external-behavior tests for the one-command dev
 * workflow (ticket #34).
 *
 * Development is one command: `pnpm dev` runs the backend and the Vite dev
 * server together; the dev server proxies the API routes and the WebSocket
 * endpoint to the backend, so the browser talks to one origin and gets hot
 * reload. This suite boots the REAL backend (injected fakes, as in
 * server.test.ts) on a random port and a REAL Vite dev server configured with
 * the same devProxy the dev command uses, then drives HTTP and WebSocket
 * traffic through the dev server's origin — the way a browser would during
 * development. Hot reload itself is Vite's built-in behavior once the dev
 * server serves the source entry, so the suite checks that entry is served
 * (the HMR precondition) plus the two proxies.
 *
 * HTTP requests use the `Connection: close` header on purpose: a keep-alive
 * request through the proxy leaves the dev server's upgraded socket to the
 * backend open, which would make the teardown's server.close() wait for it.
 */
import { get as httpGet } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	createScriptedRunFactory,
	type RunEvent,
	type RunRequest,
} from "../src/run-factory.ts";
import {
	type ModelOption,
	type ServerHandle,
	startServer,
	type WorkspaceOption,
} from "../src/server.ts";
import { WS_PATH } from "../shared/protocol.ts";
import { devProxy } from "../web/vite.config.ts";

/** Injected fake model rows, as in server.test.ts. */
const MODELS: ModelOption[] = [
	{
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		provider: "openrouter",
	},
	{
		id: "openai/gpt-5.6-luna",
		name: "GPT 5.6 Luna",
		provider: "openrouter",
	},
];

/** Injected fake workspace rows, as in server.test.ts. */
const WORKSPACES: WorkspaceOption[] = [
	{
		id: "ws-alpha",
		path: "/opt/alpha-project",
		title: "Alpha",
		newestSessionAt: 1700000000000,
	},
];

/** The frontend source root the dev server serves (web/). */
const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));

/** A valid existing folder used as the run workspace (scripted fake requires it). */
let WORKSPACE = "";

let backend: ServerHandle;
let vite: ViteDevServer;
let vitePort = 0;
let factory: ReturnType<typeof createScriptedRunFactory>;

/** GET one path through the dev server origin, closing the connection. */
function getText(path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpGet(
			{
				host: "127.0.0.1",
				port: vitePort,
				path,
				headers: { connection: "close" },
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += String(chunk);
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body }),
				);
			},
		);
		req.on("error", reject);
	});
}

beforeAll(async () => {
	WORKSPACE = mkdtempSync(join(tmpdir(), "dsh-ws-"));
	factory = createScriptedRunFactory();
	backend = await startServer({
		port: 0,
		loadModels: () => MODELS,
		loadWorkspaces: () => WORKSPACES,
		startRun: factory.startRun,
	});
	// The real Vite dev server, proxying to the test backend: the same
	// devProxy the dev command uses, pointed at the backend's random port.
	vite = await createViteServer({
		root: WEB_ROOT,
		logLevel: "silent",
		server: {
			port: 0,
			proxy: devProxy(backend.port),
		},
	});
	await vite.listen();
	const address = vite.httpServer?.address();
	if (
		address === undefined ||
		address === null ||
		typeof address === "string"
	) {
		throw new Error("dev server did not bind a TCP port");
	}
	vitePort = address.port;
}, 60_000);

afterAll(async () => {
	// Close the dev server's pieces rather than vite.close(): its full
	// shutdown awaits the environment's in-flight processing set, which hangs
	// in the vitest environment after the root fetch + proxy traffic. Closing
	// the http server first destroys the proxy's client-side socket, which
	// makes http-proxy tear down its socket to the backend — so
	// backend.close()'s server shutdown does not wait on a lingering
	// connection.
	await vite.watcher.close();
	await vite.ws.close();
	await new Promise<void>((resolve) => vite.httpServer?.close(() => resolve()));
	await backend.close();
	rmSync(WORKSPACE, { recursive: true, force: true });
}, 30_000);

describe("dev server origin", () => {
	it("serves the app shell with the source entry (the hot reload precondition)", async () => {
		const res = await getText("/");
		expect(res.status).toBe(200);
		expect(res.body).toContain('<div id="root">');
		// The dev server serves the source entry (web/src/main.tsx), not a
		// built asset — the entry Vite hot-reloads on UI edits.
		expect(res.body).toContain("/src/main.tsx");
	});
});

describe("dev proxy — API routes", () => {
	it("proxies GET /api/models to the backend", async () => {
		const res = await getText("/api/models");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body) as { models: ModelOption[] };
		expect(body.models).toEqual(MODELS);
	});

	it("proxies GET /api/workspaces to the backend", async () => {
		const res = await getText("/api/workspaces");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body) as WorkspaceOption[];
		expect(body).toEqual(WORKSPACES);
	});
});

describe("dev proxy — WebSocket endpoint", () => {
	it("proxies the WebSocket upgrade and a run lifecycle to the backend", async () => {
		const ws = new WebSocket(
			`ws://127.0.0.1:${vitePort}${WS_PATH}`,
		);
		const received: RunEvent[] = [];
		ws.on("message", (data) => received.push(parse<RunEvent>(data)));
		try {
			await new Promise<void>((resolve, reject) => {
				ws.on("open", () => resolve());
				ws.on("error", (error) => reject(error));
			});
			expect(ws.readyState).toBe(WebSocket.OPEN);

			ws.send(JSON.stringify(submitMessage(baseRequest("haiku"))));
			await waitFor(received, (e) => e.type === "run/started");

			// The run reached the backend's injected factory through the proxy.
			expect(factory.lastRun?.request.task).toBe("haiku");
			expect(received[0]).toEqual({
				type: "run/started",
				runId: factory.lastRun?.handle.id,
			});
		} finally {
			ws.terminate();
		}
	});
});

function baseRequest(task: string): RunRequest {
	return {
		task,
		primaryModel: "deepseek/deepseek-v4-flash-0731",
		laneModels: {
			left: "deepseek/deepseek-v4-flash-0731",
			right: "openai/gpt-5.6-luna",
		},
		workspace: WORKSPACE,
	};
}

function submitMessage(request: RunRequest): {
	type: "submit";
	request: RunRequest;
} {
	return { type: "submit", request };
}

function parse<T>(data: unknown): T {
	return JSON.parse(String(data)) as T;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor<T>(
	received: readonly T[],
	pred: (value: T) => boolean,
	timeoutMs = 2000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const found = received.find(pred);
		if (found !== undefined) {
			return found;
		}
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out waiting for a forwarded event");
		}
		await delay(10);
	}
}
