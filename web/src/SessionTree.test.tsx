// @vitest-environment jsdom
/**
 * SessionTree.test.tsx — component tests for the read-only session tree
 * (parent ticket #37).
 *
 * The tree renders the two-level workspace → sessions listing: a workspace
 * row per node (expandable to its sessions), and one session row per session
 * labeled by its readable `label` (the enriched seam already filters,
 * orders, and top-3-truncates). The listing is read-only — display only, no create /
 * delete / edit / reorder — and sessions appear only under their listed
 * workspace (no "Ungrouped" group). These tests pin what a user sees: the
 * rendered rows, the expand/collapse toggle, the highlighted selection, and
 * the selection reported on click.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionTree as SessionTreeData } from "./api.ts";
import { SessionTree } from "./SessionTree.tsx";

const TREE: SessionTreeData = [
	{
		id: "ws-alpha",
		path: "/opt/alpha-project",
		title: "Alpha",
		sessions: [
			{
				id: "session-1",
				label: "Refactor the seam",
				updatedAt: 1700000000000,
			},
			{
				id: "session-2",
				label: "Untitled session",
				updatedAt: 1700000500000,
			},
		],
	},
	{
		id: "ws-beta",
		path: "/opt/beta-project",
		title: "Beta",
		sessions: [
			{ id: "session-3", label: "Wire the run", updatedAt: 1700001000000 },
		],
	},
];

describe("SessionTree", () => {
	it("renders each workspace expandable to its sessions, labeled by its readable label", async () => {
		const user = userEvent.setup();
		render(
			<SessionTree
				tree={TREE}
				selectedSessionId={undefined}
				onSelect={() => {}}
			/>,
		);

		// Both workspaces are present and expanded by default.
		expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument();
		expect(screen.getByTestId("session-row-session-1")).toBeInTheDocument();
		expect(screen.getByTestId("session-row-session-2")).toBeInTheDocument();
		expect(screen.getByTestId("session-row-session-3")).toBeInTheDocument();

		// Each row shows its readable label (stored title or placeholder).
		expect(screen.getByTestId("session-row-session-1")).toHaveTextContent(
			"Refactor the seam",
		);
		expect(screen.getByTestId("session-row-session-2")).toHaveTextContent(
			"Untitled session",
		);
		expect(screen.getByTestId("session-row-session-3")).toHaveTextContent(
			"Wire the run",
		);

		// Collapsing a workspace hides its sessions; expanding restores them.
		await user.click(screen.getByRole("button", { name: /Alpha/ }));
		expect(
			screen.queryByTestId("session-row-session-1"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("session-row-session-2"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Alpha/ }));
		expect(screen.getByTestId("session-row-session-1")).toBeInTheDocument();
	});

	it("reports the clicked session through onSelect", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<SessionTree
				tree={TREE}
				selectedSessionId={undefined}
				onSelect={onSelect}
			/>,
		);

		await user.click(screen.getByTestId("session-row-session-2"));
		expect(onSelect).toHaveBeenCalledWith("session-2");
	});

	it("highlights the selected session row", () => {
		render(
			<SessionTree
				tree={TREE}
				selectedSessionId="session-2"
				onSelect={() => {}}
			/>,
		);

		const selected = screen.getByTestId("session-row-session-2");
		expect(selected).toHaveAttribute("aria-selected", "true");
		expect(selected).toHaveClass("bg-blue-100");
		expect(screen.getByTestId("session-row-session-1")).toHaveAttribute(
			"aria-selected",
			"false",
		);
	});

	it("shows an empty-catalog hint when the tree has no workspaces", () => {
		render(
			<SessionTree
				tree={[]}
				selectedSessionId={undefined}
				onSelect={() => {}}
			/>,
		);
		expect(
			screen.getByText(/No workspaces in the catalog/),
		).toBeInTheDocument();
	});
});
