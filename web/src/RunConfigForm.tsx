/**
 * RunConfigForm.tsx — the run configuration form (ticket #32).
 *
 * The form collects everything a run needs: the task text, the primary model,
 * the workspace, a lane model per lane, and submit/cancel buttons. The model
 * and workspace selectors populate from the model-list and workspace-list
 * endpoints (GET /api/models, GET /api/workspaces) on mount; every input is
 * disabled until both lists have loaded, so the user never configures a run
 * against empty data.
 *
 * The run request carries the session to resume (parent ticket #37): the
 * shared protocol now has `sessionId` instead of `workspace`. The session
 * browser that supplies the selected session lands in ticket #41; until then
 * the form takes an optional `sessionId` (defaulting to empty) and keeps the
 * workspace dropdown, which #41 removes.
 *
 * The run lifecycle — wiring submit/cancel to the WebSocket and locking the
 * inputs while a run is active — is ticket #33. This form only renders and
 * loads, and exposes the three seams #33 builds on: an optional `onSubmit`
 * receiving the assembled run request (the shared protocol shape, ticket #30),
 * an optional `onCancel` invoked by the Cancel button, and an optional
 * `locked` flag that disables the inputs and arms Cancel.
 */
import { useEffect, useRef, useState } from "react";
import type { RunRequest } from "../../shared/protocol.ts";
import {
	fetchModels,
	fetchWorkspaces,
	type ModelOption,
	type ModelsResponse,
	type WorkspaceOption,
} from "./api.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { WorkspaceSelect } from "./WorkspaceSelect.tsx";

export interface RunConfigFormProps {
	/**
	 * Load the model list and its defaults. Defaults to the /api/models
	 * fetch; tests inject a fake to control when the data resolves.
	 */
	readonly loadModels?: () => Promise<ModelsResponse>;
	/**
	 * Load the workspace catalog. Defaults to the /api/workspaces fetch;
	 * tests inject a fake. The workspace dropdown itself is removed by the
	 * session browser (ticket #41); until then it still loads.
	 */
	readonly loadWorkspaces?: () => Promise<readonly WorkspaceOption[]>;
	/**
	 * The session to resume (parent ticket #37): the run request carries this
	 * session id instead of a workspace. The session browser (ticket #41)
	 * supplies the selected session; until then it defaults to empty.
	 */
	readonly sessionId?: string;
	/**
	 * Lock the inputs (ticket #33 wires this while a run is active). While
	 * locked, every input and Submit are disabled and Cancel is enabled.
	 */
	readonly locked?: boolean;
	/**
	 * Called with the assembled run request when the user submits. Absent
	 * until the run lifecycle (ticket #33) wires it.
	 */
	readonly onSubmit?: (request: RunRequest) => void;
	/**
	 * Called when the user clicks Cancel. Wired by the run lifecycle (ticket
	 * #33) to abort the active run; the button is armed only while locked.
	 */
	readonly onCancel?: () => void;
}

/** The form's data-loading phase: inputs stay disabled until ready. */
type LoadState = "loading" | "ready" | "error";

/**
 * Preselect the workspace with the newest session, else the first row — the
 * same recency rule the vanilla UI shipped. Returns "" for an empty catalog.
 */
function preselectWorkspace(workspaces: readonly WorkspaceOption[]): string {
	let preselect = -1;
	let newestAt = -1;
	workspaces.forEach((workspace, index) => {
		if (
			typeof workspace.newestSessionAt === "number" &&
			workspace.newestSessionAt > newestAt
		) {
			newestAt = workspace.newestSessionAt;
			preselect = index;
		}
	});
	return preselect >= 0
		? (workspaces[preselect]?.path ?? "")
		: (workspaces[0]?.path ?? "");
}

export function RunConfigForm({
	loadModels = fetchModels,
	loadWorkspaces = fetchWorkspaces,
	sessionId = "",
	locked = false,
	onSubmit,
	onCancel,
}: RunConfigFormProps) {
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [models, setModels] = useState<readonly ModelOption[]>([]);
	const [workspaces, setWorkspaces] = useState<readonly WorkspaceOption[]>([]);
	const [task, setTask] = useState("");
	const [primaryModel, setPrimaryModel] = useState("");
	const [laneModels, setLaneModels] = useState<{
		readonly left: string;
		readonly right: string;
	}>({ left: "", right: "" });
	const [workspace, setWorkspace] = useState("");

	// The loaders are static seams (the endpoint fetches in production, fakes
	// in tests); load once on mount. Refs keep the effect independent of the
	// props' identities so a re-render never re-fetches.
	const loadModelsRef = useRef(loadModels);
	const loadWorkspacesRef = useRef(loadWorkspaces);
	useEffect(() => {
		let cancelled = false;
		Promise.all([loadModelsRef.current(), loadWorkspacesRef.current()])
			.then(([modelData, workspaceRows]) => {
				if (cancelled) {
					return;
				}
				setModels(modelData.models);
				setPrimaryModel(modelData.defaults.primary);
				setLaneModels({
					left: modelData.defaults.left,
					right: modelData.defaults.right,
				});
				setWorkspaces(workspaceRows);
				setWorkspace(preselectWorkspace(workspaceRows));
				setLoadState("ready");
			})
			.catch(() => {
				// Keep the inputs disabled: a form with no data must not look
				// configurable. The run lifecycle (ticket #33) may surface the
				// failure; the form itself stays inert.
				if (!cancelled) {
					setLoadState("error");
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const ready = loadState === "ready";
	const inputsDisabled = !ready || locked;
	const canSubmit = ready && workspace !== "" && !locked;

	const handleSubmit = (): void => {
		if (!canSubmit) {
			return;
		}
		onSubmit?.({
			task,
			primaryModel,
			laneModels: { left: laneModels.left, right: laneModels.right },
			sessionId,
		});
	};

	return (
		<section
			aria-label="Run configuration"
			className="rounded-lg border border-slate-200 bg-white p-4"
		>
			<div className="flex flex-col gap-1">
				<label htmlFor="task" className="text-sm font-semibold">
					Task
				</label>
				<textarea
					id="task"
					rows={4}
					value={task}
					disabled={inputsDisabled}
					onChange={(event) => setTask(event.target.value)}
					placeholder="Describe the task the two models should work on…"
					className="mt-2 min-h-[88px] w-full rounded-md border border-slate-300 p-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
				/>
			</div>

			<div className="mt-3 flex flex-wrap items-end gap-3">
				<ModelSelect
					id="primary-model"
					label="Primary model"
					models={models}
					value={primaryModel}
					disabled={inputsDisabled}
					onChange={setPrimaryModel}
				/>
				<div className="flex flex-col gap-1">
					<WorkspaceSelect
						id="workspace"
						label="Workspace"
						workspaces={workspaces}
						value={workspace}
						disabled={inputsDisabled}
						onChange={setWorkspace}
					/>
					{ready && workspaces.length === 0 && (
						<div id="workspace-hint" className="text-xs text-gray-500">
							No workspaces in the catalog yet — create one in DSH web. There is
							no path fallback.
						</div>
					)}
				</div>
				<button
					id="submit"
					type="button"
					disabled={!canSubmit}
					onClick={handleSubmit}
					className="rounded-md border border-slate-300 bg-blue-600 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
				>
					Submit
				</button>
				<button
					id="cancel"
					type="button"
					disabled={!locked}
					onClick={onCancel}
					className="rounded-md border border-slate-300 bg-gray-600 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
				>
					Cancel
				</button>
			</div>

			<div className="mt-3 flex flex-wrap items-end gap-3">
				<ModelSelect
					id="lane-left-model"
					label="Left lane model"
					models={models}
					value={laneModels.left}
					disabled={inputsDisabled}
					onChange={(modelId) =>
						setLaneModels((previous) => ({ ...previous, left: modelId }))
					}
				/>
				<ModelSelect
					id="lane-right-model"
					label="Right lane model"
					models={models}
					value={laneModels.right}
					disabled={inputsDisabled}
					onChange={(modelId) =>
						setLaneModels((previous) => ({ ...previous, right: modelId }))
					}
				/>
			</div>
		</section>
	);
}
