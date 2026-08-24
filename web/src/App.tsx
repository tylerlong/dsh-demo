/**
 * App.tsx — the harness-workflow app shell (ticket #33 wires the run lifecycle;
 * parent ticket #37 wires the session browser).
 *
 * The single-page application is two regions: a left read-only workspace →
 * sessions tree (loaded once on page load from /api/sessions; the latest
 * session is preselected and its row highlighted), and a right region with the
 * run configuration form (task, primary model, lane models; submit disabled
 * until a session is selected), the selected session's transcript (a recent
 * ~100-line window read from the store — never assembled from streamed
 * deltas), and the run section (run status + the two lanes' status chips).
 *
 * The run lifecycle hook (useRun) owns the WebSocket connection and the run
 * state machine; the form's submit and cancel wire to it, its `locked` flag
 * locks the form inputs while a run is active, and the lanes render the
 * per-lane status. Live updates: the hook watches the viewed session, and when
 * the server pushes session/updated for it, the transcript is re-read from the
 * store. Switching sessions is always a fresh store read; the tree itself is
 * never auto-reloaded (the catalog is read-only and owned by DSH web).
 *
 * Styling is Tailwind utilities only (the old flat stylesheet is deleted);
 * the existing look is converted to utility classes as the components land.
 */
import { useEffect, useRef, useState } from "react";
import type { SessionTranscript, SessionTree } from "./api.ts";
import { fetchSessions, fetchTranscript } from "./api.ts";
import { Lane } from "./Lane.tsx";
import { RunConfigForm, type RunConfigFormProps } from "./RunConfigForm.tsx";
import { SessionTree as SessionTreePanel } from "./SessionTree.tsx";
import { Transcript } from "./Transcript.tsx";
import { type RunState, useRun } from "./useRun.ts";

export interface AppProps {
	/**
	 * Create the run WebSocket; defaults to a real socket to the shared
	 * WS_PATH. Tests inject a fake so the whole lifecycle is scriptable.
	 */
	readonly createSocket?: () => WebSocket;
	/** Load the model list; forwarded to the run configuration form. */
	readonly loadModels?: RunConfigFormProps["loadModels"];
	/**
	 * Load the read-only workspace → sessions tree; defaults to the
	 * /api/sessions fetch. Tests inject a fake.
	 */
	readonly loadSessions?: () => Promise<SessionTree>;
	/**
	 * Load one session's transcript from the store; defaults to the
	 * /api/sessions/:id/transcript fetch. Tests inject a fake.
	 */
	readonly loadTranscript?: (sessionId: string) => Promise<SessionTranscript>;
}

/** The run-level status text; idle shows no status at all. */
function runStatusText(runState: RunState, elapsed: number): string {
	if (runState === "idle") {
		return "";
	}
	return `${runState} · ${elapsed}s`;
}

/** The latest session across the whole tree (the preselect rule). */
function latestSessionId(tree: SessionTree): string | undefined {
	let latest: { id: string; createdAt: number } | undefined;
	for (const workspace of tree) {
		for (const session of workspace.sessions) {
			if (latest === undefined || session.createdAt > latest.createdAt) {
				latest = session;
			}
		}
	}
	return latest?.id;
}

export function App({
	createSocket,
	loadModels,
	loadSessions = fetchSessions,
	loadTranscript = fetchTranscript,
}: AppProps) {
	const [tree, setTree] = useState<SessionTree>([]);
	const [selectedSessionId, setSelectedSessionId] = useState<
		string | undefined
	>(undefined);
	const [transcript, setTranscript] = useState<
		SessionTranscript | undefined
	>(undefined);
	const [transcriptLoading, setTranscriptLoading] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	// The task of the most recent run (shown as the primary's input line).
	const [lastTask, setLastTask] = useState<string | undefined>(undefined);
	// Which session the current transcript belongs to; used to keep the prior
	// window visible during a live refresh (only a selection change blanks it).
	const [transcriptFor, setTranscriptFor] = useState<string | undefined>(
		undefined,
	);

	// The loaders are static seams; refs keep the effects independent of the
	// props' identities so re-renders never re-fetch.
	const loadSessionsRef = useRef(loadSessions);
	const loadTranscriptRef = useRef(loadTranscript);
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	const lastWatchedRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
	}, [selectedSessionId]);

	const run = useRun({
		createSocket,
		onSessionUpdated: (sessionId) => {
			// Only the viewed session's updates trigger a re-read.
			if (sessionId === selectedSessionIdRef.current) {
				setRefreshKey((key) => key + 1);
			}
		},
	});
	// The watch action is recreated on every useRun render; hold it in a ref
	// so the transcript effect below does not re-run on unrelated renders.
	const watchRef = useRef(run.watch);
	useEffect(() => {
		watchRef.current = run.watch;
	});

	// After a socket reconnect, re-read the viewed transcript so it does not
	// stay stale until the next session/updated push happens to arrive (parent
	// #37). The first connect (connecting → connected) is not a reconnect.
	const lastConnectionRef = useRef(run.connectionStatus);
	useEffect(() => {
		const previous = lastConnectionRef.current;
		lastConnectionRef.current = run.connectionStatus;
		const reconnected =
			run.connectionStatus === "connected" &&
			(previous === "disconnected" || previous === "error");
		if (reconnected) {
			setRefreshKey((key) => key + 1);
		}
	}, [run.connectionStatus]);

	// Load the read-only tree once on page load; never auto-reloaded.
	useEffect(() => {
		let cancelled = false;
		loadSessionsRef
			.current()
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				setTree(loaded);
				// Preselect the latest session; keep an existing selection.
				setSelectedSessionId((current) => current ?? latestSessionId(loaded));
			})
			.catch(() => {
				// The tree stays empty; the panel shows its empty-catalog hint.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Watch the viewed session and read its transcript from the store on
	// selection change and on every session/updated push (refreshKey).
	useEffect(() => {
		if (selectedSessionId === undefined) {
			setTranscript(undefined);
			setTranscriptFor(undefined);
			setTranscriptLoading(false);
			return;
		}
		// Tell the server which session this tab views — once per selection,
		// not on every live refresh (the server keeps the watcher until the
		// selection changes or the tab closes).
		if (lastWatchedRef.current !== selectedSessionId) {
			lastWatchedRef.current = selectedSessionId;
			watchRef.current(selectedSessionId);
		}
		let cancelled = false;
		// A selection change blanks the panel (loading); a live refresh keeps
		// the prior window visible while the fresh store read is in flight.
		if (transcriptFor !== selectedSessionId) {
			setTranscriptLoading(true);
		}
		loadTranscriptRef
			.current(selectedSessionId)
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				setTranscript(loaded);
				setTranscriptFor(selectedSessionId);
				setTranscriptLoading(false);
			})
			.catch(() => {
				if (cancelled) {
					return;
				}
				setTranscript(undefined);
				setTranscriptFor(selectedSessionId);
				setTranscriptLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedSessionId, refreshKey]);

	return (
		<div className="min-h-screen bg-slate-100 text-slate-900">
			<header className="border-b border-slate-200 bg-white">
				<div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
					<h1 className="text-xl font-semibold tracking-tight">
						harness-workflow
					</h1>
					<div className="text-sm text-slate-500">
						connection:{" "}
						<span
							data-testid="conn-status"
							className="font-medium text-slate-700"
						>
							{run.connectionStatus}
						</span>
					</div>
				</div>
			</header>
			<main className="mx-auto flex max-w-6xl items-start gap-6 px-6 py-6">
				<aside className="w-72 shrink-0">
					<SessionTreePanel
						tree={tree}
						selectedSessionId={selectedSessionId}
						onSelect={setSelectedSessionId}
					/>
				</aside>
				<div className="flex min-w-0 flex-1 flex-col gap-6">
					<RunConfigForm
						loadModels={loadModels}
						sessionId={selectedSessionId}
						locked={run.locked}
						onSubmit={(request) => {
							setLastTask(request.task);
							run.submit(request);
						}}
						onCancel={run.cancel}
					/>
					<Transcript
						sessionId={selectedSessionId}
						transcript={transcript}
						loading={transcriptLoading}
						laneTexts={run.laneTexts}
						task={lastTask}
					/>
					<section
						aria-label="Run"
						className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4"
					>
						<div className="flex items-center justify-between">
							<h2 className="text-sm font-semibold">Run</h2>
							<span
								data-testid="primary-status"
								className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
							>
								{runStatusText(run.runState, run.runElapsed)}
							</span>
						</div>
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							<Lane
								laneId="left"
								heading="Left lane"
								status={run.lanes.left.status}
								elapsed={run.lanes.left.elapsed}
							/>
							<Lane
								laneId="right"
								heading="Right lane"
								status={run.lanes.right.status}
								elapsed={run.lanes.right.elapsed}
							/>
						</div>
					</section>
				</div>
			</main>
		</div>
	);
}
