/**
 * RunConfigForm.tsx — the run configuration form (ticket #32, parent #37).
 *
 * The form collects everything a run needs: the task text, the primary model,
 * a lane model per lane, and submit/cancel buttons. The model selectors
 * populate from the model-list endpoint (GET /api/models) on mount; every
 * input is disabled until the list has loaded, so the user never configures a
 * run against empty data.
 *
 * The workspace dropdown is gone (parent ticket #37): the run **continues** the
 * session selected in the left session-browser panel, so the form receives the
 * selected session's id via `sessionId` and keeps Submit disabled until one is
 * selected. The task field starts empty.
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
import { fetchModels, type ModelOption, type ModelsResponse } from "./api.ts";
import { ModelSelect } from "./ModelSelect.tsx";

export interface RunConfigFormProps {
	/**
	 * Load the model list and its defaults. Defaults to the /api/models
	 * fetch; tests inject a fake to control when the data resolves.
	 */
	readonly loadModels?: () => Promise<ModelsResponse>;
	/**
	 * The id of the session selected in the session browser (parent #37); the
	 * run continues this session. Submit stays disabled until one is selected.
	 * Absent when the catalog is empty or nothing is selected yet.
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

export function RunConfigForm({
	loadModels = fetchModels,
	sessionId,
	locked = false,
	onSubmit,
	onCancel,
}: RunConfigFormProps) {
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [models, setModels] = useState<readonly ModelOption[]>([]);
	const [task, setTask] = useState("");
	const [primaryModel, setPrimaryModel] = useState("");
	const [laneModels, setLaneModels] = useState<{
		readonly left: string;
		readonly right: string;
	}>({ left: "", right: "" });

	// The loader is a static seam (the endpoint fetch in production, a fake in
	// tests); load once on mount. Refs keep the effect independent of the
	// props' identities so a re-render never re-fetches.
	const loadModelsRef = useRef(loadModels);
	useEffect(() => {
		let cancelled = false;
		loadModelsRef
			.current()
			.then((modelData) => {
				if (cancelled) {
					return;
				}
				setModels(modelData.models);
				setPrimaryModel(modelData.defaults.primary);
				setLaneModels({
					left: modelData.defaults.left,
					right: modelData.defaults.right,
				});
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
	// Submit is armed only once a session is selected (parent #37): the run
	// continues the session picked in the browser, and never starts without one.
	const canSubmit = ready && sessionId !== undefined && !locked;

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
				<button
					id="submit"
					type="button"
					disabled={!canSubmit}
					onClick={handleSubmit}
					className="cursor-pointer rounded-md border border-slate-300 bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
				>
					Submit
				</button>
				<button
					id="cancel"
					type="button"
					disabled={!locked}
					onClick={onCancel}
					className="cursor-pointer rounded-md border border-slate-300 bg-gray-600 px-4 py-2 text-white transition-colors hover:bg-gray-700 active:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
				>
					Cancel
				</button>
			</div>

			{ready && sessionId === undefined && (
				<div className="mt-2 text-xs text-gray-500">
					Select a session to continue — Submit stays disabled until then.
				</div>
			)}

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
