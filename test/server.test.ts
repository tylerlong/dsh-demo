/**
 * server.test.ts — external-behavior tests for the harness-workflow server.
 *
 * The server is a plain Node http server that serves the built frontend output
 * (web/dist), exposes the harness-configured model list via /api/models, and
 * upgrades to WebSocket. These tests exercise those seams at their public
 * boundary (HTTP + WebSocket), injecting a fixed model list instead of booting
 * the harness. The run lifecycle (submit/cancel over the socket) is ticket #4.
 */
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import WebSocket from "ws";
import {
	createScriptedRunFactory,
	type RunEvent,
	type RunRequest,
} from "../src/run-factory.ts";
import {
	type ModelOption,
	type ServerHandle,
	type ServerOptions,
	startServer,
	type WorkspaceOption,
} from "../src/server.ts";

/** The agreed default selection (primary & left lane: DeepSeek V4 Flash 0731; right lane: GPT 5.6 Luna). */
const AGREED_DEFAULTS = {
	primary: "deepseek/deepseek-v4-flash-0731",
	left: "deepseek/deepseek-v4-flash-0731",
	right: "openai/gpt-5.6-luna",
};

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
	{
		id: "deepseek/deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro 0813",
		provider: "openrouter",
	},
];

/** Injected fake workspace rows served over /api/workspaces (ticket #19). */
const WORKSPACES: WorkspaceOption[] = [
	{
		id: "ws-alpha",
		path: "/opt/alpha-project",
		title: "Alpha",
		newestSessionAt: 1700000000000,
	},
	{
		id: "ws-beta",
		path: "/opt/beta-project",
		title: "Beta",
		newestSessionAt: 1700000500000,
	},
];

/** The frontend source root, whose production build the static-page suite serves. */
const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));

/**
 * Build the frontend once for this file: the static-page suite fetches the
 * built output (web/dist) the way the serve command serves it. The build
 * happens in test setup, so no new prod-code seam is introduced for testing.
 */
beforeAll(async () => {
	await build({ root: WEB_ROOT, logLevel: "silent" });
}, 120_000);

/** Every running server, closed together after each test. */
const live: ServerHandle[] = [];

function serverOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
	return {
		loadModels: () => MODELS,
		loadWorkspaces: () => WORKSPACES,
		...overrides,
	};
}

async function start(
	overrides: Partial<ServerOptions> = {},
): Promise<ServerHandle> {
	const handle = await startServer(serverOptions(overrides));
	live.push(handle);
	return handle;
}

afterEach(async () => {
	await Promise.all(live.splice(0).map((handle) => handle.close()));
});

describe("server boot", () => {
	it("binds to 127.0.0.1 on the default port 4173 and prints its URL", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const handle = await start();

		expect(handle.host).toBe("127.0.0.1");
		expect(handle.port).toBe(4173);
		expect(handle.url).toBe("http://127.0.0.1:4173");
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("http://127.0.0.1:4173"),
		);
		log.mockRestore();
	});

	it("accepts a configurable custom port", async () => {
		const handle = await start({ port: 0, host: "127.0.0.1" });
		expect(handle.port).toBeGreaterThan(0);
		expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
	});
});

describe("static page", () => {
	it("serves the built index shell with the app entry and its asset references", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();

		// The built React shell: the mount root and the module script entry.
		expect(html).toContain('<div id="root">');
		expect(html).toContain('<script type="module"');

		// The entry script is served as a real asset with a JS content type.
		// Layout and behavior are verified by the component tests and the e2e,
		// so this suite stops at the index shell and asset references.
		const asset = html.match(/src="([^"]+\.js)"/)?.[1];
		expect(asset).toBeTruthy();
		const assetRes = await fetch(`${handle.url}${asset}`);
		expect(assetRes.status).toBe(200);
		expect(assetRes.headers.get("content-type")).toContain("javascript");
	});

	it("404s unknown GET routes — no SPA fallback to the index document", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/no-such-page`);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toContain("<!doctype html>");
	});
});

describe("obsolete vendor localforage asset", () => {
	it("is gone — the route returns 404", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/vendor/localforage.js`);
		expect(res.status).toBe(404);
	});
});

describe("model list endpoint", () => {
	it("serves the configured model list with the agreed defaults", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/api/models`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			models: ModelOption[];
			defaults: typeof AGREED_DEFAULTS;
		};
		expect(body.models).toEqual(MODELS);
		expect(body.defaults).toEqual(AGREED_DEFAULTS);
	});
});

describe("workspace list endpoint", () => {
	it("serves the injected workspace rows", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/api/workspaces`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceOption[];
		expect(body).toEqual(WORKSPACES);
	});

	it("serves an injected empty list", async () => {
		const handle = await start({ port: 0, loadWorkspaces: () => [] });
		const res = await fetch(`${handle.url}/api/workspaces`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as WorkspaceOption[];
		expect(body).toEqual([]);
	});
});

describe("obsolete workspace check route", () => {
	it("is gone — the endpoint returns 404", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/api/workspace/check`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "/opt/alpha-project" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("websocket", () => {
	it("upgrades and accepts a connection", async () => {
		const handle = await start({ port: 0 });
		const ws = new WebSocket(handle.wsUrl);
		try {
			await new Promise<void>((resolve, reject) => {
				ws.on("open", () => resolve());
				ws.on("error", (error) => reject(error));
			});
			expect(ws.readyState).toBe(WebSocket.OPEN);
		} finally {
			ws.close();
		}
	});
});
/**
 * ws run lifecycle (ticket #4) — driven entirely through the injected
 * scripted run factory: no real LLM, no harness boot. Each test injects the
 * fake startRun, drives the socket the way a browser tab would, and asserts
 * the run events routed to that tab plus the factory calls they produce.
 */
function connect(handle: ServerHandle): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(handle.wsUrl);
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

function sendJson(ws: WebSocket, value: unknown): void {
	ws.send(JSON.stringify(value));
}

interface SubmitMessage {
	readonly type: "submit";
	readonly request: RunRequest;
}

function submitMessage(request: RunRequest): SubmitMessage {
	return { type: "submit", request };
}

function baseRequest(task: string): RunRequest {
	return {
		task,
		primaryModel: "deepseek/deepseek-v4-flash-0731",
		laneModels: {
			left: "deepseek/deepseek-v4-flash-0731",
			right: "openai/gpt-5.6-luna",
		},
		sessionId: "session-ws-test",
	};
}


function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parse<T>(data: unknown): T {
	return JSON.parse(String(data)) as T;
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

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await delay(10);
	}
}

describe("ws run lifecycle", () => {
	it("submit starts the run factory and forwards its run/started", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		const received: RunEvent[] = [];
		ws.on("message", (data) => received.push(parse<RunEvent>(data)));
		try {
			sendJson(ws, submitMessage(baseRequest("haiku")));
			await waitFor(received, (e) => e.type === "run/started");

			expect(factory.lastRun?.request).toEqual(baseRequest("haiku"));
			expect(received[0]).toEqual({
				type: "run/started",
				runId: factory.lastRun?.handle.id,
			});
		} finally {
			ws.close();
		}
	});

	it("an empty session id fails both lanes and ends the run before any worker starts", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		const received: RunEvent[] = [];
		ws.on("message", (data) => received.push(parse<RunEvent>(data)));
		try {
			const request = baseRequest("haiku");
			request.sessionId = "";
			sendJson(ws, submitMessage(request));
			await waitFor(received, (e) => e.type === "run/started");

			const leftError = (await waitFor(
				received,
				(e) => e.type === "lane/worker/error" && e.laneId === "left",
			)) as { reason?: string };
			const rightError = (await waitFor(
				received,
				(e) => e.type === "lane/worker/error" && e.laneId === "right",
			)) as { reason?: string };
			const done = await waitFor(received, (e) => e.type === "run/done");

			// Both lanes error and the run ends; the reason stays server-side.
			expect(leftError.reason).toBeUndefined();
			expect(rightError.reason).toBeUndefined();
			expect(done).toEqual({
				type: "run/done",
				runId: factory.lastRun?.handle.id,
			});
			// The run never spawned a worker.
			expect(factory.lastRun?.request.sessionId).toBe("");
		} finally {
			ws.close();
		}
	});

	it("routes worker events to their lane and orchestrator events to the top", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		const received: RunEvent[] = [];
		ws.on("message", (data) => received.push(parse<RunEvent>(data)));
		try {
			sendJson(ws, submitMessage(baseRequest("haiku")));
			await waitFor(received, (e) => e.type === "run/started");
			const run = factory.lastRun;
			if (run === undefined) throw new Error("expected a started run");

			run.emit({ type: "lane/worker/started", laneId: "left" });
			run.emit({ type: "orchestrator/delta", text: "spawning workers" });
			run.emit({ type: "lane/worker/delta", laneId: "left", text: "the" });
			run.emit({ type: "lane/worker/delta", laneId: "right", text: "sea" });

			await waitFor(
				received,
				(e) => e.type === "lane/worker/delta" && e.laneId === "right",
			);
			const leftDelta = received.find(
				(e) => e.type === "lane/worker/delta" && e.laneId === "left",
			);
			expect(leftDelta).toEqual({
				type: "lane/worker/delta",
				laneId: "left",
				text: "the",
			});
			const orchestrator = received.find(
				(e) => e.type === "orchestrator/delta",
			);
			expect(orchestrator).toEqual({
				type: "orchestrator/delta",
				text: "spawning workers",
			});
		} finally {
			ws.close();
		}
	});

	it("cancel aborts the whole run via the factory's cancel()", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		try {
			sendJson(ws, submitMessage(baseRequest("haiku")));
			await waitUntil(() => factory.lastRun !== undefined);
			expect(factory.lastRun?.canceled).toBe(false);

			sendJson(ws, { type: "cancel" });
			await waitUntil(() => factory.lastRun?.canceled === true);
		} finally {
			ws.close();
		}
	});

	it("a terminal run/canceled frees the tab to start a new run", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		try {
			sendJson(ws, submitMessage(baseRequest("haiku one")));
			await waitUntil(() => factory.lastRun !== undefined);

			// Production emits run/canceled once the abort completes.
			factory.lastRun?.emit({ type: "run/canceled", runId: "0" });
			await waitUntil(() => factory.runs.length === 1);

			sendJson(ws, submitMessage(baseRequest("haiku two")));
			await waitUntil(() => factory.runs.length === 2);
			expect(factory.runs[1]?.request.task).toBe("haiku two");
		} finally {
			ws.close();
		}
	});

	it("a lane error is logged to the server console and forwarded", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const ws = await connect(handle);
		const received: RunEvent[] = [];
		ws.on("message", (data) => received.push(parse<RunEvent>(data)));
		try {
			const request = baseRequest("haiku");
			sendJson(ws, submitMessage(request));
			await waitFor(received, (e) => e.type === "run/started");

			factory.lastRun?.emit({
				type: "lane/worker/error",
				laneId: "left",
				reason: "rate limited",
			});
			const errored = (await waitFor(
				received,
				(e) => e.type === "lane/worker/error",
			)) as { laneId?: string; reason?: string };
			// The lane is told which side failed, but the reason stays server-side.
			expect(errored.laneId).toBe("left");
			expect(errored.reason).toBeUndefined();
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("rate limited"),
			);
		} finally {
			consoleError.mockRestore();
			ws.close();
		}
	});

	it("closing a tab cancels only its run; two tabs are independent", async () => {
		const factory = createScriptedRunFactory();
		const handle = await start({ port: 0, startRun: factory.startRun });
		const wsA = await connect(handle);
		const wsB = await connect(handle);
		try {
			sendJson(wsA, submitMessage(baseRequest("tab a")));
			sendJson(wsB, submitMessage(baseRequest("tab b")));
			await waitUntil(() => factory.runs.length === 2);
			expect(factory.runs.map((r) => r.request.task)).toEqual([
				"tab a",
				"tab b",
			]);

			wsA.close();
			await waitUntil(() => factory.runs[0]?.canceled === true);
			expect(factory.runs[1]?.canceled).toBe(false);
		} finally {
			wsA.close();
			wsB.close();
		}
	});
});
