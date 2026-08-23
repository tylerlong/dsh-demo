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
 * The server implements the full run lifecycle over each WebSocket
 * connection (submit / cancel / streaming, per-tab isolation) via the
 * injected run-factory seam; the harness-backed factory is wired in serve.ts.
 *
 * Run directly with `pnpm serve` (boots the harness for the model list), or
 * embed the seam: tests inject `startServer` with a fixed loadModels.
 */
import { createServer, type Server } from "node:http";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { ModelOption } from "./model-list.ts";
import { resolveDefaults } from "./model-list.ts";
import type {
	LaneId,
	RunEvent,
	RunHandle,
	RunRequest,
	StartRun,
} from "./run-factory.ts";

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
	/**
	 * Inject the run factory (ticket #4): the server's only dependency on
	 * orchestration. Tests inject the scripted fake (run-factory.ts); the
	 * harness-backed factory is wired in ticket #5. While absent, a submit is
	 * logged and ignored — the browser only enters its running state once the
	 * factory confirms a run, so nothing hangs in the interim.
	 */
	readonly startRun?: StartRun;
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
  .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; }
  .chip.running { background: #dbeafe; color: #1d4ed8; }
  .chip.done { background: #dcfce7; color: #15803d; }
  .chip.error { background: #fee2e2; color: #b91c1c; }
  .chip.canceled { background: #e5e7eb; color: #374151; }
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
  var LANES = ["left", "right"];
  var state = { running: false, runElapsed: 0 };
  var laneTimers = { left: null, right: null };
  var laneSeconds = { left: 0, right: 0 };
  var laneRunning = { left: false, right: false };
  var runTimer = null;
  var ws = null;

  function el(id) { return document.getElementById(id); }

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
      var select = el(id + "-model");
      data.models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name + " (" + model.provider + ")";
        select.appendChild(option);
        if (model.id === def) select.value = model.id;
      });
    });
  }

  // ---- per-lane status chips and elapsed timers ----
  function setLaneChip(lane, text, cls) {
    var chip = el(lane + "-status");
    chip.textContent = text;
    chip.className = "status chip";
    if (cls) chip.className += " " + cls;
  }
  function clearLane(lane) {
    stopLaneTimer(lane);
    laneSeconds[lane] = 0;
    laneRunning[lane] = false;
    el(lane + "-output").textContent = "";
    setLaneChip(lane, "", "");
  }
  function startLaneTimer(lane) {
    laneRunning[lane] = true;
    laneSeconds[lane] = 0;
    setLaneChip(lane, "running · 0s", "running");
    laneTimers[lane] = setInterval(function () {
      laneSeconds[lane] += 1;
      setLaneChip(lane, "running · " + laneSeconds[lane] + "s", "running");
    }, 1000);
  }
  function stopLaneTimer(lane) {
    if (laneTimers[lane]) { clearInterval(laneTimers[lane]); laneTimers[lane] = null; }
  }
  function finishLane(lane, status, cls) {
    var seconds = laneSeconds[lane] || 0;
    laneRunning[lane] = false;
    stopLaneTimer(lane);
    setLaneChip(lane, status + " · " + seconds + "s", cls);
  }

  // ---- run-level state: lock the inputs, drive a run-level timer ----
  function showRunStatus(text) { el("primary-status").textContent = text; }
  function setInputsLocked(locked) {
    ["task", "primary-model", "lane-left-model", "lane-right-model", "submit"].forEach(function (id) {
      el(id).disabled = locked;
    });
    el("cancel").disabled = !locked;
  }
  function startRun() {
    state.running = true;
    state.runElapsed = 0;
    el("primary-output").textContent = "";
    LANES.forEach(clearLane);
    setInputsLocked(true);
    showRunStatus("running · 0s");
    runTimer = setInterval(function () {
      state.runElapsed += 1;
      showRunStatus("running · " + state.runElapsed + "s");
    }, 1000);
  }
  function endRun(status) {
    state.running = false;
    if (runTimer) { clearInterval(runTimer); runTimer = null; }
    LANES.forEach(stopLaneTimer);
    setInputsLocked(false);
    showRunStatus(status + " · " + state.runElapsed + "s");
  }
  function appendText(target, text) { if (text) target.textContent += text; }

  // ---- route run events: lane events to their panel, orchestrator to top ----
  function handleEvent(msg) {
    switch (msg.type) {
      case "run/started":
        startRun();
        break;
      case "run/done":
        // A clear completion signal: any lane still running is done.
        LANES.forEach(function (lane) {
          if (laneRunning[lane]) finishLane(lane, "done", "done");
        });
        endRun("done");
        break;
      case "run/canceled":
        // The whole run aborted: running lanes wind down to canceled.
        LANES.forEach(function (lane) {
          if (laneRunning[lane]) finishLane(lane, "canceled", "canceled");
        });
        endRun("canceled");
        break;
      case "run/summary":
        appendText(el("primary-output"), "\n" + msg.summary);
        break;
      case "orchestrator/delta":
        appendText(el("primary-output"), msg.text);
        break;
      case "lane/worker/started":
        startLaneTimer(msg.laneId);
        break;
      case "lane/worker/delta":
        appendText(el(msg.laneId + "-output"), msg.text);
        break;
      case "lane/worker/done":
        finishLane(msg.laneId, "done", "done");
        break;
      case "lane/worker/error":
        // The reason is logged server-side; the lane just shows its error chip.
        finishLane(msg.laneId, "error", "error");
        break;
    }
  }

  // ---- the run WebSocket: submit and cancel ----
  function openSocket() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host + "/ws");
    ws.onopen = function () { el("conn-status").textContent = "connected"; };
    ws.onclose = function () { el("conn-status").textContent = "disconnected"; };
    ws.onerror = function () { el("conn-status").textContent = "error"; };
    ws.onmessage = function (e) {
      try { handleEvent(JSON.parse(e.data)); } catch (_) { /* ignore malformed */ }
    };

    el("submit").addEventListener("click", function () {
      if (state.running || !ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        type: "submit",
        request: {
          task: el("task").value,
          primaryModel: el("primary-model").value,
          laneModels: {
            left: el("lane-left-model").value,
            right: el("lane-right-model").value
          }
        }
      }));
    });

    el("cancel").addEventListener("click", function () {
      if (state.running && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "cancel" }));
      }
    });
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
	wss.on("connection", (ws) => {
		handleConnection(ws, options);
	});

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
			// Terminate open WebSocket clients first: server.close() waits for
			// open connections, so a tab left open would hang shutdown.
			for (const client of wss.clients) {
				client.terminate();
			}
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

/** One run bound to a WebSocket connection; the connection is its identity. */
interface ConnectionRun {
	/** The factory handle for the active run on this connection. */
	readonly handle: RunHandle;
}

/** A message a browser tab sends to the /ws server. */
interface ClientMessage {
	readonly type: "submit" | "cancel" | string;
	/** Populated for a submit; the run request to forward to the factory. */
	readonly request?: unknown;
}

/**
 * The run lifecycle over one WebSocket connection (ticket #4).
 *
 * Each tab owns one run for the life of its connection: submit starts the
 * injected factory's run and streams its events back; cancel and disconnect
 * abort the run. The connection is the run's identity, so multiple tabs run
 * independent comparisons and closing or refreshing a tab cancels only that
 * tab's run (per-tab isolation, parent ticket #1).
 */
function handleConnection(ws: WebSocket, options: ServerOptions): void {
	let current: ConnectionRun | undefined;

	/** Forward one run event to the client, logging lane errors server-side. */
	const onEvent = (event: RunEvent): void => {
		if (event.type === "lane/worker/error") {
			// The reason is for the server console only, never the UI.
			console.error(
				`dsh-compare: lane ${event.laneId} worker error: ${event.reason}`,
			);
			// Strip the reason from the wire: the lane just shows its error chip.
			sendEvent(ws, { type: "lane/worker/error", laneId: event.laneId });
			return;
		}
		if (event.type === "run/done" || event.type === "run/canceled") {
			// The run reached a terminal state; a new submit may start one.
			current = undefined;
		}
		sendEvent(ws, event);
	};

	ws.on("message", (data) => {
		const message = parseMessage(data);
		if (message === undefined) {
			return;
		}
		if (message.type === "submit") {
			if (current !== undefined) {
				// One run per connection; a submit mid-run is ignored.
				console.error(
					"dsh-compare: submit ignored — a run is already active on this tab",
				);
				return;
			}
			if (options.startRun === undefined) {
				// Absent until ticket #5 wires the harness-backed factory.
				console.error(
					"dsh-compare: no run factory wired (ticket #5); submit ignored",
				);
				return;
			}
			if (isRunRequest(message.request)) {
				current = {
					handle: options.startRun(message.request, onEvent),
				};
			}
		} else if (message.type === "cancel") {
			current?.handle.cancel();
		}
	});

	ws.on("close", () => {
		// Closing or refreshing a tab cancels only this tab's run.
		current?.handle.cancel();
		current = undefined;
	});
}

/**
 * The client-facing wire event: the run event vocabulary minus the lane error
 * reason, which stays on the server console only.
 */
type WireEvent = RunEvent | { type: "lane/worker/error"; laneId: LaneId };

// Serialize and send one wire event to the client, if the socket is open.
function sendEvent(ws: WebSocket, event: WireEvent): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(event));
	}
}

/** Parse a text WS frame into a client message, or undefined if malformed. */
function parseMessage(data: RawData): ClientMessage | undefined {
	let text: string;
	if (typeof data === "string") {
		text = data;
	} else if (Array.isArray(data)) {
		text = Buffer.concat(data).toString();
	} else if (data instanceof ArrayBuffer) {
		text = Buffer.from(data).toString();
	} else {
		text = data.toString();
	}
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && typeof value.type === "string") {
			return { type: value.type, request: value.request };
		}
	} catch {
		// Not JSON; ignore the malformed frame.
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The light shape check that makes a submit safe to forward to the factory. */
function isRunRequest(value: unknown): value is RunRequest {
	if (!isRecord(value)) {
		return false;
	}
	const laneModels = value.laneModels;
	return (
		typeof value.task === "string" &&
		typeof value.primaryModel === "string" &&
		isRecord(laneModels) &&
		typeof laneModels.left === "string" &&
		typeof laneModels.right === "string"
	);
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
