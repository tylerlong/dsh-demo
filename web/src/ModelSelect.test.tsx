// @vitest-environment jsdom
/**
 * ModelSelect.test.tsx — external-behavior tests for the model selector.
 *
 * The selector is a labeled dropdown over the model options loaded from
 * /api/models (ticket #32). These tests exercise what a user sees and does:
 * the options rendered (one per model, id as value, "name (provider)" as
 * text), the disabled state, and the selection reported on change.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelOption } from "./api.ts";
import { ModelSelect } from "./ModelSelect.tsx";

const MODELS: readonly ModelOption[] = [
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
];

describe("ModelSelect", () => {
	it("renders one option per model with the model id as its value", () => {
		render(
			<ModelSelect
				id="primary-model"
				label="Primary model"
				models={MODELS}
				value={MODELS[0]!.id}
				onChange={() => {}}
			/>,
		);

		const select = screen.getByRole("combobox", { name: "Primary model" });
		expect(select).toHaveValue(MODELS[0]!.id);
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(2);
		expect(options[0]).toHaveValue(MODELS[0]!.id);
		expect(options[0]).toHaveTextContent("DeepSeek V4 Flash 0731 (openrouter)");
		expect(options[1]).toHaveValue(MODELS[1]!.id);
		expect(options[1]).toHaveTextContent("GPT 5.6 Luna (openrouter)");
	});

	it("reports the newly selected model id", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<ModelSelect
				id="primary-model"
				label="Primary model"
				models={MODELS}
				value={MODELS[0]!.id}
				onChange={onChange}
			/>,
		);

		await user.selectOptions(
			screen.getByRole("combobox", { name: "Primary model" }),
			MODELS[1]!.id,
		);
		expect(onChange).toHaveBeenCalledWith(MODELS[1]!.id);
	});

	it("disables the select when disabled", () => {
		render(
			<ModelSelect
				id="primary-model"
				label="Primary model"
				models={MODELS}
				value={MODELS[0]!.id}
				disabled
				onChange={() => {}}
			/>,
		);

		expect(
			screen.getByRole("combobox", { name: "Primary model" }),
		).toBeDisabled();
	});
});
