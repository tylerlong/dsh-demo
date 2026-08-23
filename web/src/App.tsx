/**
 * App.tsx — the harness-workflow app shell (ticket #33 wires the run lifecycle).
 *
 * The single-page application's outer structure: a header naming the product
 * with the live connection status (connecting / connected / disconnected /
 * error), and a main content region holding the run configuration form, the
 * run's top section (run status + the orchestrator's streamed output), and
 * the two lanes rendered side by side. The run lifecycle hook (useRun) owns
 * the WebSocket connection and the run state machine; the form's submit and
 * cancel wire to it, its `locked` flag locks the form inputs while a run is
 * active, and the lanes render the per-lane state the hook streams in.
 *
 * Styling is Tailwind utilities only (the old flat stylesheet is deleted);
 * the existing look is converted to utility classes as the components land.
 */
import { Lane } from "./Lane.tsx";
import { RunConfigForm, type RunConfigFormProps } from "./RunConfigForm.tsx";
import { type RunState, useRun } from "./useRun.ts";

export interface AppProps {
	/**
	 * Create the run WebSocket; defaults to a real socket to the shared
	 * WS_PATH. Tests inject a fake so the whole lifecycle is scriptable.
	 */
	readonly createSocket?: () => WebSocket;
	/** Load the model list; forwarded to the run configuration form. */
	readonly loadModels?: RunConfigFormProps["loadModels"];
	/** Load the workspace catalog; forwarded to the run configuration form. */
	readonly loadWorkspaces?: RunConfigFormProps["loadWorkspaces"];
}

/** The run-level status text; idle shows no status at all. */
function runStatusText(runState: RunState, elapsed: number): string {
	if (runState === "idle") {
		return "";
	}
	return `${runState} · ${elapsed}s`;
}

export function App({ createSocket, loadModels, loadWorkspaces }: AppProps) {
	const run = useRun({ createSocket });
	return (
		<div className="min-h-screen bg-slate-100 text-slate-900">
			<header className="border-b border-slate-200 bg-white">
				<div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
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
			<main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
				<RunConfigForm
					loadModels={loadModels}
					loadWorkspaces={loadWorkspaces}
					locked={run.locked}
					onSubmit={run.submit}
					onCancel={run.cancel}
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
					<pre
						data-testid="primary-output"
						className="min-h-[64px] whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-xs"
					>
						{run.orchestratorOutput}
					</pre>
				</section>
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					<Lane
						laneId="left"
						heading="Left lane"
						status={run.lanes.left.status}
						output={run.lanes.left.output}
						elapsed={run.lanes.left.elapsed}
					/>
					<Lane
						laneId="right"
						heading="Right lane"
						status={run.lanes.right.status}
						output={run.lanes.right.output}
						elapsed={run.lanes.right.elapsed}
					/>
				</div>
			</main>
		</div>
	);
}
