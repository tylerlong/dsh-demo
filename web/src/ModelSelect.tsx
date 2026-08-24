/**
 * ModelSelect.tsx — one model dropdown for the run configuration form.
 *
 * Renders a labeled <select> over the model options loaded from /api/models
 * (ticket #32). The same component backs the primary model slot and each
 * lane's model slot; the id and label come from the caller so the form can
 * address each slot (#primary-model, #lane-left-model, #lane-right-model).
 * Each option's value is the model id and its text is "name (provider)",
 * matching the dropdown the vanilla UI shipped.
 */
import type { ModelOption } from "./api.ts";

export interface ModelSelectProps {
	/** The select's element id (also its label's for attribute). */
	readonly id: string;
	/** The visible label text. */
	readonly label: string;
	/** The model options to render, in dropdown order. */
	readonly models: readonly ModelOption[];
	/** The currently selected model id. */
	readonly value: string;
	/** Whether the select is disabled (e.g. while the data is loading). */
	readonly disabled?: boolean;
	/** Called with the newly selected model id. */
	readonly onChange: (modelId: string) => void;
}

export function ModelSelect({
	id,
	label,
	models,
	value,
	disabled = false,
	onChange,
}: ModelSelectProps) {
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="text-sm font-semibold">
				{label}
			</label>
			<select
				id={id}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				className="cursor-pointer rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
			>
				{models.map((model) => (
					<option key={model.id} value={model.id}>
						{model.name} ({model.provider})
					</option>
				))}
			</select>
		</div>
	);
}
