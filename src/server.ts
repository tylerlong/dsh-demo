/**
 * server.ts — the dsh-compare HTTP + WebSocket server and static UI shell.
 *
 * A Node http server bound to 127.0.0.1 on a configurable port (default 4173)
 * that serves the static page and upgrades to WebSocket. The page shell is a
 * top section (task textarea, primary model dropdown, Submit / Cancel,
 * primary output/status) above two lanes, each with its own model dropdown and
 * output panel. Dropdowns are populated at runtime from the harness's
 * configured model list (see model-list.ts) via GET /api/models.
 *
 * Ticket #3 scope is the server + WebSocket + UI shell only: the server
 * accepts WebSocket connections but does not yet run the lifecycle over them
 * (submit / cancel / streaming is ticket #4).
 *
 * Run directly with `pnpm serve` (boots the harness for the model list), or
 * embed the seam: tests inject `startServer` with a fixed loadModels.
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { ModelOption } from "./model-list.ts";
import { resolveDefaults } from "./model-list.ts";

/** Re-export the dropdown option shape the /api/models endpoint serves. */
export type { ModelOption } from "./model-list.ts";

/** Default host the server binds to (loopback only). */
export const DEFAULT_HOST = "127.0.0.1";
/** Default port the server listens on. */
export const DEFAULT_PORT = 4173;
/** WebSocket endpoint path. */
export const WS_PATH = "/ws";

/** Options for {@link startServer}. */
export interface ServerOptions {
	/** Port to bind; default {@link DEFAULT_PORT}. */
	readonly port?: number;
	/** Host to bind; default {@link DEFAULT_HOST}. */
	readonly host?: string;
	/**
	 * Inject the configured model list. Production passes a loader backed by
	 * the harness's llm registry (see model-list.ts); tests pass a fixed list.
	 */
	readonly loadModels: () =>
		| Promise<readonly ModelOption[]>
		| readonly ModelOption[];
}

/** A running dsh-compare server. */
export interface ServerHandle {
	/** Bound host. */
	readonly host: string;
	/** Bound port (the actual one when `port: 0` was requested). */
	readonly port: number;
	/** The http URL, e.g. `http://127.0.0.1:4173`. */
	readonly url: string;
	/** The WebSocket endpoint URL. */
	readonly wsUrl: string;
	/** Close the server (WebSocket upgrades and http serving). */
	close(): Promise<void>;
}

/** Serve the static UI shell. The dropdowns fill themselves via /api/models. */
function pageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-compare</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1a1a1a; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  header h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .panel { background: #fff; border: 1px solid #dfe2e6; border-radius: 8px; padding: 16px; margin-top: 16px; }
  label { font-weight: 600; font-size: 0.85rem; }
  select, textarea, button { font: inherit; }
  textarea { width: 100%; min-height: 88px; box-sizing: border-box; margin-top: 8px; padding: 8px; }
  .row { display: flex; gap: 12px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  button { padding: 8px 16px; border-radius: 6px; border: 1px solid #cfd3d8; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #cancel { background: #4b5563; }
  .output { margin-top: 12px; min-height: 90px; border: 1px dashed #dfe2e6; border-radius: 6px; padding: 10px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 0.85rem; background: #fbfcfe; }
  .status { font-size: 0.75rem; color: #6b7280; }
  #lanes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .lane h2 { font-size: 1.05rem; margin: 0 0 8px; }
  @media (max-width: 760px) { #lanes { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>dsh-compare</h1>
    <div class="status">connection: <span id="conn-status">connecting…</span></div>
  </header>

  <section class="panel" aria-label="Run configuration">
    <label for="task">Task</label>
    <textarea id="task" placeholder="Describe the task the two models should work on…" rows="4"></textarea>
    <div class="row">
      <div class="field">
        <label for="primary-model">Primary model</label>
        <select id="primary-model"></select>
      </div>
      <button id="submit" type="button">Submit</button>
      <button id="cancel" type="button" disabled>Cancel</button>
    </div>
    <div class="output" id="primary-output" aria-label="Primary output"></div>
    <div class="status" id="primary-status"></div>
  </section>

  <div id="lanes">
    <section class="panel lane" aria-label="Left lane">
      <h2>Left lane</h2>
      <div class="field">
        <label for="lane-left-model">Model</label>
        <select id="lane-left-model"></select>
      </div>
      <div class="output" id="lane-left-output" aria-label="Left lane output"></div>
      <div class="status" id="lane-left-status"></div>
    </section>
    <section class="panel lane" aria-label="Right lane">
      <h2>Right lane</h2>
      <div class="field">
        <label for="lane-right-model">Model</label>
        <select id="lane-right-model"></select>
      </div>
      <div class="output" id="lane-right-output" aria-label="Right lane output"></div>
      <div class="status" id="lane-right-status"></div>
    </section>
  </div>
</main>
<script>
(function () {
  "use strict";
  // Populate the three model dropdowns from the harness-configured list.
  async function populateModelLists() {
    var res = await fetch("/api/models");
    var data = await res.json();
    var slots = [
      ["primary", data.defaults.primary],
      ["lane-left", data.defaults.left],
      ["lane-right", data.defaults.right]
    ];
    slots.forEach(function (slot) {
      var id = slot[0], def = slot[1];
      var select = document.getElementById(id + "-model");
      data.models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name + " (" + model.provider + ")";
        select.appendChild(option);
        if (model.id === def) select.value = model.id;
      });
    });
  }

  // Open the run's WebSocket. Ticket #4 wires submit/cancel/streaming here.
  function openSocket() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var ws = new WebSocket(proto + location.host + "/ws");
    ws.onopen = function () { document.getElementById("conn-status").textContent = "connected"; };
    ws.onclose = function () { document.getElementById("conn-status").textContent = "disconnected"; };
    ws.onerror = function () { document.getElementById("conn-status").textContent = "error"; };
  }

  populateModelLists();
  openSocket();
})();
</script>
</body>
</html>`;
}

/**
 * Start the dsh-compare server: bind, serve the static page and /api/models,
 * and accept WebSocket connections. Resolves once the server is listening.
 */
export async function startServer(
	options: ServerOptions,
): Promise<ServerHandle> {
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? DEFAULT_PORT;

	const server: Server = createServer((req, res) => {
		void handleRequest(req, res, options);
	});

	const wss = new WebSocketServer({ server, path: WS_PATH });
	// Ticket #4 implements the run lifecycle over accepted connections. For the
	// shell we only need to accept the upgrade, which the WebSocketServer does.

	let boundPort = port;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const address = server.address();
			if (address !== null && typeof address === "object") {
				boundPort = address.port;
			}
			resolve();
		});
	});

	const url = `http://${host}:${boundPort}`;
	const wsUrl = `ws://${host}:${boundPort}${WS_PATH}`;
	// The server prints its URL so a user knows where to open the tab.
	console.log(`dsh-compare listening at ${url}`);

	return {
		host,
		port: boundPort,
		url,
		wsUrl,
		close: async () => {
			wss.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		},
	};
}

/** Handle one http request: the page, the model list, or a 404. */
async function handleRequest(
	req: import("node:http").IncomingMessage,
	res: import("node:http").ServerResponse,
	options: ServerOptions,
): Promise<void> {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	if (method === "GET" && (url === "/" || url === "/index.html")) {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pageHtml());
		return;
	}
	if (method === "GET" && url === "/api/models") {
		const models = await options.loadModels();
		const defaults = resolveDefaults(models);
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ models, defaults }));
		return;
	}
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("not found");
}
