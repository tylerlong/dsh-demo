/**
 * App.tsx — the harness-workflow app shell (ticket #33 wires the run lifecycle;
 * parent ticket #37 wires the session browser).
 *
 * The single-page application is two regions: a left read-only workspace →
 * sessions tree (loaded once on page load from /api/sessions; the latest
 * session is preselected and its row highlighted), and a right region with the
 * run configuration form (task, primary model, lane models; submit disabled
 * until a session is selected), the selected session's transcript (a recent
 * prompt/answer window read from the store — never assembled from streamed
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
import { fetchSessions, fetchTranscript, TRANSCRIPT_LOAD_STEP } from "./api.ts";
import { Lane } from "./Lane.tsx";
import { RunConfigForm, type RunConfigFormProps } from "./RunConfigForm.tsx";
import { SessionTree as SessionTreePanel } from "./SessionTree.tsx";
import { Transcript } from "./Transcript.tsx";

// Resizable left-panel bounds and the localStorage key (default = w-72, 288px).
const SIDEBAR_WIDTH_DEFAULT = 288;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 600;
const SIDEBAR_WIDTH_KEY = "harness-workflow.sidebarWidth";

/** Clamp the left-panel width to its bounds. */
function clampSidebarWidth(width: number): number {
	return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
}

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
	 * /api/sessions/:id/transcript fetch. `limit` sizes the primary window
	 * (the last N prompt/answer pairs), so "load more" grows it backward one
	 * pair at a time. Tests inject a fake.
	 */
	readonly loadTranscript?: (
		sessionId: string,
		limit?: number,
	) => Promise<SessionTranscript>;
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
	let latest: { id: string; updatedAt: number } | undefined;
	for (const workspace of tree) {
		for (const session of workspace.sessions) {
			if (latest === undefined || session.updatedAt > latest.updatedAt) {
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
	const [transcript, setTranscript] = useState<SessionTranscript | undefined>(
		undefined,
	);
	const [transcriptLoading, setTranscriptLoading] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	// The primary window size requested from the store (the last N prompt/
	// answer pairs). Defaults to one pair — the most recent prompt plus its
	// answer. "Load more" grows it by TRANSCRIPT_LOAD_STEP; a session change
	// resets it to the default window so a new selection never inherits
	// another session's pagination.
	const [transcriptLimit, setTranscriptLimit] = useState(TRANSCRIPT_LOAD_STEP);
	// The most recent run that actually began, bound to its session: the
	// submitted task (shown as that session's primary input line) and the
	// session the lane answers belong to. Keyed by session so switching
	// sessions never shows one run's content under another's transcript.
	const [runStart, setRunStart] = useState<
		{ sessionId: string; task: string } | undefined
	>(undefined);
	// Which session the current transcript belongs to; used to keep the prior
	// window visible during a live refresh (only a selection change blanks it).
	// A ref (not state): only the effect reads/writes it, and re-rendering on
	// its change would re-run the fetch effect.
	const transcriptForRef = useRef<string | undefined>(undefined);

	// The resizable left-panel width (px). Defaults to w-72 (288px); persisted
	// to localStorage so the preference survives reloads.
	const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
		const stored = Number.parseInt(
			localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "",
			10,
		);
		return Number.isFinite(stored) ? stored : SIDEBAR_WIDTH_DEFAULT;
	});
	// Drag state for the resize handle: the pointer id and the width at drag
	// start, so the divider walks the panel under a press-drag.
	const dragRef = useRef<
		{ pointerId: number; startX: number; startWidth: number } | undefined
	>(undefined);

	const startSidebarDrag = (pointerId: number, clientX: number): void => {
		dragRef.current = { pointerId, startX: clientX, startWidth: sidebarWidth };
	};
	// Clamp the drag to sane bounds so the tree never collapses or swallows
	// the right panel.
	const updateSidebarDrag = (clientX: number): void => {
		const drag = dragRef.current;
		if (drag === undefined) return;
		const next = clampSidebarWidth(drag.startWidth + (clientX - drag.startX));
		setSidebarWidth(next);
	};
	const endSidebarDrag = (): void => {
		if (dragRef.current === undefined) return;
		dragRef.current = undefined;
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	};

	// The loaders are static seams; refs keep the effects independent of the
	// props' identities so re-renders never re-fetch.
	const loadSessionsRef = useRef(loadSessions);
	const loadTranscriptRef = useRef(loadTranscript);
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	const lastWatchedRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
	}, [selectedSessionId]);

	// Select a session from the tree: switch the selection and reset the
	// transcript window to its default size (a new session never inherits
	// another session's pagination).
	const selectSession = (sessionId: string): void => {
		setSelectedSessionId(sessionId);
		setTranscriptLimit(TRANSCRIPT_LOAD_STEP);
	};

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
	// selection change, on every session/updated push (refreshKey), and on
	// every "load more" (transcriptLimit grows the window).
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a manual refresh trigger incremented on live updates/reconnect; the effect re-runs on it but never reads its value.
	useEffect(() => {
		if (selectedSessionId === undefined) {
			setTranscript(undefined);
			transcriptForRef.current = undefined;
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
		// A selection change blanks the panel (loading); a live refresh or a
		// "load more" keeps the prior window visible while the fresh store
		// read is in flight.
		if (transcriptForRef.current !== selectedSessionId) {
			setTranscriptLoading(true);
		}
		loadTranscriptRef
			.current(selectedSessionId, transcriptLimit)
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				setTranscript(loaded);
				transcriptForRef.current = selectedSessionId;
				setTranscriptLoading(false);
			})
			.catch(() => {
				if (cancelled) {
					return;
				}
				setTranscript(undefined);
				transcriptForRef.current = selectedSessionId;
				setTranscriptLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedSessionId, refreshKey, transcriptLimit]);

	return (
		<div className="min-h-screen bg-slate-100 text-slate-900">
			<header className="border-b border-slate-200 bg-white">
				<div className="flex items-center justify-between px-6 py-4">
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
			<main className="flex items-stretch">
				<aside
					className="sticky top-0 h-screen shrink-0 overflow-y-auto bg-white p-4"
					style={{ width: sidebarWidth }}
				>
					<SessionTreePanel
						tree={tree}
						selectedSessionId={selectedSessionId}
						onSelect={selectSession}
					/>
				</aside>
				{/* biome-ignore lint/a11y/useSemanticElements: interactive resizable separator (ARIA separator pattern), not a static <hr>. */}
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					aria-valuenow={sidebarWidth}
					aria-valuemin={SIDEBAR_WIDTH_MIN}
					aria-valuemax={SIDEBAR_WIDTH_MAX}
					tabIndex={0}
					onKeyDown={(event) => {
						// Keyboard resize for the focusable separator (ARIA
						// separator pattern): ArrowLeft narrows, ArrowRight widens.
						if (event.key === "ArrowLeft") {
							setSidebarWidth(clampSidebarWidth(sidebarWidth - 16));
							event.preventDefault();
						} else if (event.key === "ArrowRight") {
							setSidebarWidth(clampSidebarWidth(sidebarWidth + 16));
							event.preventDefault();
						}
					}}
					onPointerDown={(event) => {
						// Pointer capture keeps the drag alive even if the cursor
						// leaves the divider mid-drag.
						event.currentTarget.setPointerCapture(event.pointerId);
						startSidebarDrag(event.pointerId, event.clientX);
					}}
					onPointerMove={(event) => updateSidebarDrag(event.clientX)}
					onPointerUp={() => endSidebarDrag()}
					onPointerCancel={() => endSidebarDrag()}
					className="w-1.5 shrink-0 cursor-col-resize touch-none border-r border-slate-200 hover:border-blue-400 focus:border-blue-400 focus:outline-none"
				/>
				<div className="flex min-w-0 flex-1 justify-center">
					<div className="flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
						<RunConfigForm
							loadModels={loadModels}
							sessionId={selectedSessionId}
							locked={run.locked}
							onSubmit={(request) => {
								// Record the run only when the request was actually
								// sent (submit is a no-op while disconnected or a
								// run is active).
								if (run.submit(request)) {
									setRunStart({
										sessionId: request.sessionId,
										task: request.task,
									});
								}
							}}
							onCancel={run.cancel}
						/>
						<Transcript
							sessionId={selectedSessionId}
							transcript={transcript}
							loading={transcriptLoading}
							laneTexts={run.laneTexts}
							runStart={runStart}
							onLoadMore={() =>
								setTranscriptLimit((limit) => limit + TRANSCRIPT_LOAD_STEP)
							}
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
				</div>
			</main>
		</div>
	);
}
