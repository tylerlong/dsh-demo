// @vitest-environment jsdom
/**
 * WorkspaceSelect.test.tsx — external-behavior tests for the workspace selector.
 *
 * The selector is a labeled dropdown over the workspace rows loaded from
 * /api/workspaces (ticket #32). These tests exercise what a user sees and
 * does: the options rendered (one per row, path as value, "title (path)" as
 * text), the disabled state, and the selection reported on change.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceOption } from "./api.ts";
import { WorkspaceSelect } from "./WorkspaceSelect.tsx";

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

describe("WorkspaceSelect", () => {
	it("renders one option per workspace with the path as its value", () => {
		render(
			<WorkspaceSelect
				id="workspace"
				label="Workspace"
				workspaces={WORKSPACES}
				value={WORKSPACES[0]!.path}
				onChange={() => {}}
			/>,
		);

		const select = screen.getByRole("combobox", { name: "Workspace" });
		expect(select).toHaveValue(WORKSPACES[0]!.path);
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(2);
		expect(options[0]).toHaveValue(WORKSPACES[0]!.path);
		expect(options[0]).toHaveTextContent("Alpha (/opt/alpha-project)");
		expect(options[1]).toHaveValue(WORKSPACES[1]!.path);
		expect(options[1]).toHaveTextContent("Beta (/opt/beta-project)");
	});

	it("reports the newly selected workspace path", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<WorkspaceSelect
				id="workspace"
				label="Workspace"
				workspaces={WORKSPACES}
				value={WORKSPACES[0]!.path}
				onChange={onChange}
			/>,
		);

		await user.selectOptions(
			screen.getByRole("combobox", { name: "Workspace" }),
			WORKSPACES[1]!.path,
		);
		expect(onChange).toHaveBeenCalledWith(WORKSPACES[1]!.path);
	});

	it("disables the select when disabled", () => {
		render(
			<WorkspaceSelect
				id="workspace"
				label="Workspace"
				workspaces={WORKSPACES}
				value={WORKSPACES[0]!.path}
				disabled
				onChange={() => {}}
			/>,
		);

		expect(screen.getByRole("combobox", { name: "Workspace" })).toBeDisabled();
	});
});
