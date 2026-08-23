/**
 * model-list.ts — the harness-model seam for the harness-workflow dropdowns.
 *
 * The three model dropdowns (primary, left lane, right lane) are populated at
 * runtime from the harness's configured provider settings (the llm-pi-ai
 * namespace). This module is the thin adapter from the harness's llm registry
 * (`ctx.llm`) to a neutral ModelOption shape the server can serve over
 * /api/models, plus the agreed default selection (primary & left lane:
 * DeepSeek V4 Flash 0731; right lane: GPT 5.6 Luna).
 *
 * Keeping the harness vocabulary (provider / model id / display name) here,
 * isolated from the HTTP + WebSocket layer, is what lets the server be tested
 * without booting the real harness.
 */

/** One selectable model option shown in a dropdown. */
export interface ModelOption {
	/** Provider route that owns this model. */
	readonly provider: string;
	/** Model id sent to the provider (also the option's value). */
	readonly id: string;
	/** Human-readable model name shown in the dropdown. */
	readonly name: string;
}

/** The default model selected in each of the three slots. */
export interface DefaultModels {
	/** Model id for the orchestrator's primary agent. */
	readonly primary: string;
	/** Model id for the left lane's worker. */
	readonly left: string;
	/** Model id for the right lane's worker. */
	readonly right: string;
}

/**
 * The agreed defaults: primary & left lane on DeepSeek V4 Flash 0731, right
 * lane on GPT 5.6 Luna (these ids match the llm-pi-ai provider settings).
 */
export const DEFAULT_MODEL_IDS: DefaultModels = {
	primary: "deepseek/deepseek-v4-flash-0731",
	left: "deepseek/deepseek-v4-flash-0731",
	right: "openai/gpt-5.6-luna",
};

/**
 * The narrow slice of the harness llm registry this adapter needs. Production
 * passes `ctx.llm`; tests pass a fake. Kept structural so we do not reach
 * into Cordis types from the server layer.
 */
export interface LlmLike {
	/**
	 * The live, registered provider routes. Only these have an adapter able to
	 * list its models — the configurable directory also names dormant catalog
	 * routes (e.g. amazon-bedrock) with no adapter, so we iterate this.
	 */
	listProviders(): readonly { readonly id: string }[];
	/** The configured model list for one registered provider role. */
	listModels(provider: string): Promise<
		readonly {
			readonly provider: string;
			readonly id: string;
			readonly name: string;
		}[]
	>;
}

/**
 * Read the harness's configured model list from its llm registry, flattened
 * across every live registered provider. Each provider's models are listed
 * once (in provider order, then catalog order).
 */
export async function convertLlmModels(
	llm: LlmLike,
): Promise<readonly ModelOption[]> {
	const models: ModelOption[] = [];
	for (const provider of llm.listProviders()) {
		for (const model of await llm.listModels(provider.id)) {
			models.push({
				provider: model.provider,
				id: model.id,
				name: model.name,
			});
		}
	}
	return models;
}

/**
 * Resolve a concrete default model id for each slot against the available
 * models. An agreed default that is actually present is kept; a missing one
 * (provider no longer configured) falls back to the first available model, so
 * the dropdown never ends up empty.
 * @param models - the configured model list.
 * @param configured - the agreed defaults.
 * @returns one model id per slot, each present in `models`.
 */
export function resolveDefaults(
	models: readonly ModelOption[],
	configured: DefaultModels = DEFAULT_MODEL_IDS,
): DefaultModels {
	const first = models[0]?.id;
	const pick = (id: string): string =>
		models.some((model) => model.id === id) ? id : (first ?? "");
	return {
		primary: pick(configured.primary),
		left: pick(configured.left),
		right: pick(configured.right),
	};
}
