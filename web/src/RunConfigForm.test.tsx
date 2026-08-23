// @vitest-environment jsdom
/**
 * RunConfigForm.test.tsx — external-behavior tests for the run configuration
 * form (ticket #32, parent #37).
 *
 * The form renders the task input, the primary model selector, a lane model
 * selector per lane, and submit/cancel buttons; the model selectors populate
 * from the model-list endpoint (an injected loader standing in for the
 * fetch), and every input stays disabled until the data has loaded. The
 * workspace dropdown is gone (parent #37): the run continues the session
 * selected in the left panel, so the form receives the session id via
 * `sessionId` and keeps submit disabled until one is selected. These tests
 * assert only what a user sees and does — rendered controls, populated
 * options, disabled/enabled states, and the assembled request handed to
 * submit — never component internals.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelsResponse } from "./api.ts";
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
		leftLane: screen.getByRole("combobox", { name: "Left lane model" }),
		rightLane: screen.getByRole("combobox", { name: "Right lane model" }),
		submit: screen.getByRole("button", { name: "Submit" }),
		cancel: screen.getByRole("button", { name: "Cancel" }),
	};
}

describe("RunConfigForm", () => {
	it("renders the task input, model selectors, and submit/cancel — no workspace dropdown", async () => {
		render(
			<RunConfigForm loadModels={async () => MODELS} sessionId="session-2" />,
		);

		const form = controls();
		expect(form.task).toBeInTheDocument();
		expect(form.primary).toBeInTheDocument();
		expect(form.leftLane).toBeInTheDocument();
		expect(form.rightLane).toBeInTheDocument();
		expect(form.submit).toBeInTheDocument();
		expect(form.cancel).toBeInTheDocument();
		// The workspace dropdown is removed (parent #37): the workspace comes
		// from the selected session's cwd, not the form.
		expect(
			screen.queryByRole("combobox", { name: "Workspace" }),
		).not.toBeInTheDocument();

		// The loaded data populates the selectors; the defaults preselect the
		// primary and lane models.
		await waitFor(() => expect(form.primary).toBeEnabled());
		expect(form.primary).toHaveValue(MODELS.defaults.primary);
		expect(form.leftLane).toHaveValue(MODELS.defaults.left);
		expect(form.rightLane).toHaveValue(MODELS.defaults.right);
	});

	it("keeps every input disabled until the data has loaded", async () => {
		const models = deferred<ModelsResponse>();
		render(
			<RunConfigForm
				loadModels={() => models.promise}
				sessionId="session-2"
			/>,
		);

		const form = controls();
		expect(form.task).toBeDisabled();
		expect(form.primary).toBeDisabled();
		expect(form.leftLane).toBeDisabled();
		expect(form.rightLane).toBeDisabled();
		expect(form.submit).toBeDisabled();

		// Once the model list resolves, the inputs unlock and submit becomes
		// usable (a session is selected).
		models.resolve(MODELS);
		await waitFor(() => expect(form.task).toBeEnabled());
		expect(form.primary).toBeEnabled();
		expect(form.leftLane).toBeEnabled();
		expect(form.rightLane).toBeEnabled();
		expect(form.submit).toBeEnabled();
	});

	it("starts with an empty task field", async () => {
		render(
			<RunConfigForm loadModels={async () => MODELS} sessionId="session-2" />,
		);
		await waitFor(() => expect(controls().task).toBeEnabled());
		expect(controls().task).toHaveValue("");
	});

	it("keeps submit disabled until a session is selected, with a hint", async () => {
		const user = userEvent.setup();
		render(<RunConfigForm loadModels={async () => MODELS} />);

		await waitFor(() =>
			expect(
				screen.getByText(/Select a session to continue/),
			).toBeInTheDocument(),
		);
		expect(controls().submit).toBeDisabled();

		// No free-text fallback: typing a task never arms submit.
		await user.type(controls().task, "haiku");
		expect(controls().submit).toBeDisabled();
	});

	it("submits the assembled run request carrying the session id", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				sessionId="session-2"
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
			sessionId: "session-2",
		});
	});

	it("locks the inputs and arms cancel while locked", async () => {
		render(
			<RunConfigForm
				loadModels={async () => MODELS}
				sessionId="session-2"
				locked
			/>,
		);

		// Ready, but locked: every input and submit stay disabled, cancel arms.
		await waitFor(() =>
			expect((controls().primary as HTMLSelectElement).options).toHaveLength(2),
		);
		expect(controls().task).toBeDisabled();
		expect(controls().primary).toBeDisabled();
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
				sessionId="session-2"
			/>,
		);

		// Let the rejection settle, then assert the form stays inert.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const form = controls();
		expect(form.task).toBeDisabled();
		expect(form.primary).toBeDisabled();
		expect(form.submit).toBeDisabled();
	});
});
