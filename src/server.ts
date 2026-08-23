/**
 * server.ts — the harness-workflow HTTP + WebSocket server and built frontend host.
 *
 * A Node http server bound to 127.0.0.1 on a configurable port (default 4173)
 * that serves the built React frontend (web/dist, produced by the serve
 * command's vite build) as a generic static file server and upgrades to
 * WebSocket. The frontend is a TypeScript + Vite + React single-page
 * application (see web/); its model and workspace dropdowns populate at
 * runtime from the harness's configured model list (see model-list.ts) via
 * GET /api/models and from the shared workspace catalog via GET /api/workspaces.
 *
 * The server implements the full run lifecycle over each WebSocket
 * connection (submit / cancel / streaming, per-tab isolation) via the
 * injected run-factory seam; the harness-backed factory is wired in serve.ts.
 *
 * Run directly with `pnpm serve` (boots the harness for the model list), or
 * embed the seam: tests inject `startServer` with a fixed loadModels.
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { LaneId, RunEvent, RunRequest } from "../shared/protocol.ts";
import { WS_PATH } from "../shared/protocol.ts";
import type { ModelOption } from "./model-list.ts";
import { resolveDefaults } from "./model-list.ts";
import type { RunHandle, StartRun } from "./run-factory.ts";
import type { WorkspaceOption } from "./workspace-list.ts";

/** Re-export the dropdown option shape the /api/models endpoint serves. */
export type { ModelOption } from "./model-list.ts";
/** Re-export the workspace row shape the /api/workspaces endpoint serves. */
export type { WorkspaceOption } from "./workspace-list.ts";

/** Default host the server binds to (loopback only). */
export const DEFAULT_HOST = "127.0.0.1";
/** Default port the server listens on. */
export const DEFAULT_PORT = 4173;
/** WebSocket endpoint path (shared WebSocket contract, ticket #30). */
export { WS_PATH } from "../shared/protocol.ts";

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
	 * Inject the workspace list (ticket #19), mirroring {@link loadModels}.
	 * Production passes a loader backed by the shared workspace registry and
	 * the shared session store (see workspace-list.ts); tests inject a fixed
	 * list. Backs GET /api/workspaces so the page can seed its workspace
	 * dropdown and preselect the most recently used workspace.
	 */
	readonly loadWorkspaces: () =>
		| Promise<readonly WorkspaceOption[]>
		| readonly WorkspaceOption[];
	/**
	 * Inject the run factory (ticket #4): the server's only dependency on
	 * orchestration. Tests inject the scripted fake (run-factory.ts); the
	 * harness-backed factory is wired in ticket #5. While absent, a submit is
	 * logged and ignored — the browser only enters its running state once the
	 * factory confirms a run, so nothing hangs in the interim.
	 */
	readonly startRun?: StartRun;
}

/** A running harness-workflow server. */
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

/** The built frontend directory, sibling of this module (relative to the
 * module, not the process working directory) so the default resolves correctly
 * no matter where the server is launched from. The serve command builds the
 * frontend into this directory (vite build web, output web/dist); the server
 * reads files from disk per request, so a rebuild needs no server restart. */
const DIST_DIR = fileURLToPath(new URL("../web/dist", import.meta.url));

/** Content types by file extension for the generic static file server. */
const MIME_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

/** Read a built frontend file from disk, or undefined when it cannot be served. */
async function readAsset(file: string): Promise<Buffer | undefined> {
	try {
		return await readFile(join(DIST_DIR, file));
	} catch {
		return undefined;
	}
}

/**
 * Map a GET request URL to a file under the built output, or undefined for a
 * route the static server does not own. The index document is served at the
 * root; every other path maps to the file at that relative path. There is no
 * SPA fallback: an unknown route is not rewritten to the index document and
 * keeps returning 404. Paths that would escape the built directory (a dot-dot
 * segment) are rejected rather than resolved.
 */
function staticFileFor(url: string): string | undefined {
	let path = url.split("?")[0] ?? "";
	path = path.split("#")[0] ?? "";
	try {
		path = decodeURIComponent(path);
	} catch {
		// Malformed percent-encoding cannot name a file.
		return undefined;
	}
	if (path === "/") {
		return "index.html";
	}
	if (!path.startsWith("/")) {
		return undefined;
	}
	const relative = path.slice(1);
	if (relative === "") {
		return "index.html";
	}
	if (relative.split("/").includes("..")) {
		return undefined;
	}
	return relative;
}

/**
 * Start the harness-workflow server: bind, serve the built frontend and
 * /api/models, and accept WebSocket connections. Resolves once the server is
 * listening.
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
	console.log(`harness-workflow listening at ${url}`);

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
				`harness-workflow: lane ${event.laneId} worker error: ${event.reason}`,
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
					"harness-workflow: submit ignored — a run is already active on this tab",
				);
				return;
			}
			if (options.startRun === undefined) {
				// Absent until ticket #5 wires the harness-backed factory.
				console.error(
					"harness-workflow: no run factory wired (ticket #5); submit ignored",
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
		typeof value.workspace === "string" &&
		isRecord(laneModels) &&
		typeof laneModels.left === "string" &&
		typeof laneModels.right === "string"
	);
}

/** Handle one http request: a built frontend file, the model list, the workspace list, or a 404. */
async function handleRequest(
	req: import("node:http").IncomingMessage,
	res: import("node:http").ServerResponse,
	options: ServerOptions,
): Promise<void> {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	// The API routes win over the static server so /api/* never falls through
	// to a (missing) built file.
	if (method === "GET" && url === "/api/models") {
		const models = await options.loadModels();
		const defaults = resolveDefaults(models);
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ models, defaults }));
		return;
	}
	if (method === "GET" && url === "/api/workspaces") {
		const workspaces = await options.loadWorkspaces();
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(workspaces));
		return;
	}
	const file = staticFileFor(url);
	if (method === "GET" && file !== undefined) {
		// Read the built file from disk per request (resolved relative to the
		// module), so a rebuild needs no server restart.
		const body = await readAsset(file);
		if (body === undefined) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
		});
		res.end(body);
		return;
	}
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("not found");
}
