/**
 * WorkspaceSelect.tsx — the workspace dropdown for the run configuration form.
 *
 * Renders a labeled <select> over the workspace rows loaded from
 * /api/workspaces (ticket #32). Each option's value is the workspace's
 * canonical path — the run's workspace — and its text is "title (path)",
 * matching the dropdown the vanilla UI shipped. The caller owns the selected
 * value and the recency-based preselect.
 */
import type { WorkspaceOption } from "./api.ts";

export interface WorkspaceSelectProps {
	/** The select's element id (also its label's for attribute). */
	readonly id: string;
	/** The visible label text. */
	readonly label: string;
	/** The workspace rows to render, in catalog order. */
	readonly workspaces: readonly WorkspaceOption[];
	/** The currently selected workspace path. */
	readonly value: string;
	/** Whether the select is disabled (e.g. while the data is loading). */
	readonly disabled?: boolean;
	/** Called with the newly selected workspace path. */
	readonly onChange: (path: string) => void;
}

export function WorkspaceSelect({
	id,
	label,
	workspaces,
	value,
	disabled = false,
	onChange,
}: WorkspaceSelectProps) {
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
				className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
			>
				{workspaces.map((workspace) => (
					<option key={workspace.id} value={workspace.path}>
						{workspace.title} ({workspace.path})
					</option>
				))}
			</select>
		</div>
	);
}
