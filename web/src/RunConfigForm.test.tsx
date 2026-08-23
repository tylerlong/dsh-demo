// @vitest-environment jsdom
/**
 * RunConfigForm.test.tsx — external-behavior tests for the run configuration
 * form (ticket #32).
 *
 * The form renders the task input, the primary model selector, the workspace
 * selector, a lane model selector per lane, and submit/cancel buttons; the
 * model and workspace selectors populate from the model-list and
 * workspace-list endpoints (injected loaders standing in for the fetches), and
 * every input stays disabled until the data has loaded. These tests assert
 * only what a user sees and does — rendered controls, populated options,
 * disabled/enabled states, and the assembled request handed to submit — never
 * component internals.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelsResponse, WorkspaceOption } from "./api.ts";
import { RunConfigForm } from "./RunConfigForm.tsx";

const MODELS: ModelsResponse = {
	models: [
		{
			provider: "openrouter",
			id: "deepseek/deepseek-v4-flash-0731",
			name: "DeepSeek V4 Flash 0731",
		},
		{
			provider: "openrouter",
			id: "openai/gpt-5.6-luna",
			name: "GPT 5.6 Luna",
		},
	],
	defaults: {
		primary: "deepseek/deepseek-v4-flash-0731",
		left: "deepseek/deepseek-v4-flash-0731",
		right: "openai/gpt-5.6-luna",
	},
};

const WORKSPACES: readonly WorkspaceOption[] = [
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

/** A promise the test resolves manually, to control when the data loads. */
function deferred<T>(): {
	readonly promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** The form's controls, queried the way a user sees them. */
function controls() {
	return {
		task: screen.getByLabelText("Task"),
		primary: screen.getByRole("combobox", { name: "Primary model" }),
		workspace: screen.getByRole("combobox", { name: "Workspace" }),
		leftLane: screen.getByRole("combobox", { name: "Left lane model" }),
		rightLane: screen.getByRole("combobox", { name: "Right lane model" }),
		submit: screen.getByRole("button", { name: "Submit" }),
		cancel: screen.getByRole("button", { name: "Cancel" }),
	};
}

describe("RunConfigForm", () => {
	it("renders the task input, model and workspace selectors, lane model selectors, and submit/cancel", async () => {
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => WORKSPACES}
			/>,
		);

		const form = controls();
		expect(form.task).toBeInTheDocument();
		expect(form.primary).toBeInTheDocument();
		expect(form.workspace).toBeInTheDocument();
		expect(form.leftLane).toBeInTheDocument();
		expect(form.rightLane).toBeInTheDocument();
		expect(form.submit).toBeInTheDocument();
		expect(form.cancel).toBeInTheDocument();

		// The loaded data populates the selectors; the defaults preselect the
		// primary and lane models, and the newest-session workspace wins.
		await waitFor(() => expect(form.primary).toBeEnabled());
		expect(form.primary).toHaveValue(MODELS.defaults.primary);
		expect(form.leftLane).toHaveValue(MODELS.defaults.left);
		expect(form.rightLane).toHaveValue(MODELS.defaults.right);
		expect(form.workspace).toHaveValue("/opt/beta-project");
	});

	it("keeps every input disabled until the data has loaded", async () => {
		const models = deferred<ModelsResponse>();
		const workspaces = deferred<readonly WorkspaceOption[]>();
		render(
			<RunConfigForm
				loadModels={() => models.promise}
				loadWorkspaces={() => workspaces.promise}
			/>,
		);

		const form = controls();
		expect(form.task).toBeDisabled();
		expect(form.primary).toBeDisabled();
		expect(form.workspace).toBeDisabled();
		expect(form.leftLane).toBeDisabled();
		expect(form.rightLane).toBeDisabled();
		expect(form.submit).toBeDisabled();

		// Once both lists resolve, the inputs unlock and submit becomes usable.
		models.resolve(MODELS);
		workspaces.resolve(WORKSPACES);
		await waitFor(() => expect(form.task).toBeEnabled());
		expect(form.primary).toBeEnabled();
		expect(form.workspace).toBeEnabled();
		expect(form.leftLane).toBeEnabled();
		expect(form.rightLane).toBeEnabled();
		expect(form.submit).toBeEnabled();
	});

	it("populates the model selectors from the loaded model list", async () => {
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => WORKSPACES}
			/>,
		);

		await waitFor(() => expect(controls().primary).toBeEnabled());
		const primary = controls().primary as HTMLSelectElement;
		expect(primary.options).toHaveLength(2);
		expect(primary.options[0]).toHaveValue(MODELS.models[0]!.id);
		expect(primary.options[0]).toHaveTextContent(
			"DeepSeek V4 Flash 0731 (openrouter)",
		);
		expect(primary.options[1]).toHaveValue(MODELS.models[1]!.id);
		expect((controls().leftLane as HTMLSelectElement).options).toHaveLength(2);
		expect((controls().rightLane as HTMLSelectElement).options).toHaveLength(2);
	});

	it("preselects the workspace with the most recently used session, else the first", async () => {
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => WORKSPACES}
			/>,
		);

		await waitFor(() => expect(controls().workspace).toBeEnabled());
		// Beta has the newer session, so it wins the preselect.
		expect(controls().workspace).toHaveValue("/opt/beta-project");
	});

	it("shows the empty-catalog hint and keeps submit disabled when no workspace loads", async () => {
		const user = userEvent.setup();
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => []}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByText(/No workspaces in the catalog yet/),
			).toBeInTheDocument(),
		);
		expect(controls().workspace).toBeEnabled();
		expect(controls().submit).toBeDisabled();

		// No free-text fallback: typing a task never arms submit.
		await user.type(controls().task, "haiku");
		expect(controls().submit).toBeDisabled();
	});

	it("submits the assembled run request", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => WORKSPACES}
				onSubmit={onSubmit}
			/>,
		);

		await waitFor(() => expect(controls().submit).toBeEnabled());
		await user.type(controls().task, "haiku");
		await user.click(controls().submit);

		expect(onSubmit).toHaveBeenCalledWith({
			task: "haiku",
			primaryModel: MODELS.defaults.primary,
			laneModels: {
				left: MODELS.defaults.left,
				right: MODELS.defaults.right,
			},
			sessionId: "/opt/beta-project",
		});
	});

	it("locks the inputs and arms cancel while locked", async () => {
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				loadWorkspaces={async () => WORKSPACES}
				locked
			/>,
		);

		// Ready, but locked: every input and submit stay disabled, cancel arms.
		await waitFor(() =>
			expect((controls().primary as HTMLSelectElement).options).toHaveLength(2),
		);
		expect(controls().task).toBeDisabled();
		expect(controls().primary).toBeDisabled();
		expect(controls().workspace).toBeDisabled();
		expect(controls().leftLane).toBeDisabled();
		expect(controls().rightLane).toBeDisabled();
		expect(controls().submit).toBeDisabled();
		expect(controls().cancel).toBeEnabled();
	});

	it("keeps the inputs disabled when loading fails", async () => {
		render(
			<RunConfigForm
				loadModels={async () => {
					throw new Error("models endpoint down");
				}}
				loadWorkspaces={async () => WORKSPACES}
			/>,
		);

		// Let the rejection settle, then assert the form stays inert.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const form = controls();
		expect(form.task).toBeDisabled();
		expect(form.primary).toBeDisabled();
		expect(form.workspace).toBeDisabled();
		expect(form.submit).toBeDisabled();
	});
});
