/**
 * model-list.test.ts — harness-model seam tests.
 *
 * The dropdowns are populated from the harness's configured model list (the
 * llm-pi-ai namespace). This module is the thin adapter from the harness's
 * llm registry (`ctx.llm`) to the server's neutral ModelOption shape, plus
 * the agreed default selection. These tests drive it with a fake llm service,
 * so no real harness boot or network is involved.
 */
import { describe, expect, it } from "vitest";
import {
	convertLlmModels,
	DEFAULT_MODEL_IDS,
	type ModelOption,
	resolveDefaults,
} from "../src/model-list.ts";

const MODELS: ModelOption[] = [
	{
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		provider: "openrouter",
	},
	{ id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openrouter" },
	{
		id: "deepseek/deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro 0813",
		provider: "openrouter",
	},
];

describe("convertLlmModels", () => {
	it("flattens each provider's model list into ModelOption entries", () => {
		const llm = {
			listProviders: () => [{ id: "openrouter" }, { id: "local" }],
			listModels: (provider: string) =>
				Promise.resolve(
					provider === "openrouter"
						? [
								{
									id: "deepseek/deepseek-v4-flash-0731",
									name: "DeepSeek V4 Flash 0731",
									provider,
								},
								{ id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna", provider },
							]
						: [{ id: "local/llama", name: "Local Llama", provider }],
				),
		};
		expect(convertLlmModels(llm as never)).resolves.toEqual([
			{
				id: "deepseek/deepseek-v4-flash-0731",
				name: "DeepSeek V4 Flash 0731",
				provider: "openrouter",
			},
			{
				id: "openai/gpt-5.6-luna",
				name: "GPT 5.6 Luna",
				provider: "openrouter",
			},
			{ id: "local/llama", name: "Local Llama", provider: "local" },
		]);
	});

	it("returns an empty list when no provider is configured", async () => {
		const llm = { listProviders: () => [], listModels: () => [] };
		expect(await convertLlmModels(llm as never)).toEqual([]);
	});
});

describe("resolveDefaults", () => {
	it("uses the agreed defaults when all three models are present", () => {
		expect(resolveDefaults(MODELS)).toEqual(DEFAULT_MODEL_IDS);
	});

	it("falls back to the first available model for a missing default", () => {
		const withoutRight = MODELS.filter(
			(model) => model.id !== DEFAULT_MODEL_IDS.right,
		);
		const defaults = resolveDefaults(withoutRight, DEFAULT_MODEL_IDS);
		expect(defaults.primary).toBe(DEFAULT_MODEL_IDS.primary);
		expect(defaults.left).toBe(DEFAULT_MODEL_IDS.left);
		expect(defaults.right).toBe(withoutRight[0]?.id);
	});
});
