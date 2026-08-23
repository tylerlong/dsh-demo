/**
 * server.test.ts — external-behavior tests for the dsh-compare server.
 *
 * The server is a plain Node http server that serves the static page, exposes
 * the harness-configured model list via /api/models, and upgrades to
 * WebSocket. These tests exercise those seams at their public boundary (HTTP
 * + WebSocket), injecting a fixed model list instead of booting the harness.
 * The run lifecycle (submit/cancel over the socket) is ticket #4.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
	type ModelOption,
	type ServerHandle,
	type ServerOptions,
	startServer,
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

/** Every running server, closed together after each test. */
const live: ServerHandle[] = [];

function serverOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
	return {
		loadModels: () => MODELS,
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
	it("serves the full layout: top section and two lanes", async () => {
		const handle = await start({ port: 0 });
		const res = await fetch(`${handle.url}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();

		// Top section: task textarea, primary model dropdown, Submit, Cancel, output/status.
		expect(html).toContain("<textarea");
		expect(html).toContain('id="task"');
		expect(html).toContain('id="primary-model"');
		expect(html).toContain('id="primary-output"');
		expect(html).toMatch(/submit/i);
		expect(html).toMatch(/cancel/i);

		// Two lanes, each with a model dropdown and an output panel.
		expect(html).toContain('id="lane-left-model"');
		expect(html).toContain('id="lane-left-output"');
		expect(html).toContain('id="lane-right-model"');
		expect(html).toContain('id="lane-right-output"');
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
