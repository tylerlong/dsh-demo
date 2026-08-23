/**
 * SessionTree.tsx — the read-only workspace → sessions tree (parent ticket #37).
 *
 * The session browser's left panel: a two-level listing of the workspaces DSH
 * web owns, each expandable to its sessions, loaded once on page load from
 * /api/sessions. Sessions are labeled by their id — the only stable label the
 * read-only listing provides (SessionHeader has no title field; never invent
 * one). The listing is strictly display-only: no create / delete / edit /
 * reorder, and sessions appear only under their listed workspace (no
 * "Ungrouped" group). The selected session's row is highlighted; clicking a
 * row reports the selection through onSelect.
 */
import { useState } from "react";
import type { SessionTree as SessionTreeData } from "./api.ts";

export interface SessionTreeProps {
	/** The read-only workspace → sessions tree from /api/sessions. */
	readonly tree: SessionTreeData;
	/** The currently selected session's id, or undefined before any selection. */
	readonly selectedSessionId: string | undefined;
	/** Called with the clicked session's id. */
	readonly onSelect: (sessionId: string) => void;
}

export function SessionTree({
	tree,
	selectedSessionId,
	onSelect,
}: SessionTreeProps) {
	// Workspaces start expanded; the user may collapse any of them.
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

	const toggle = (workspaceId: string): void => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(workspaceId)) {
				next.delete(workspaceId);
			} else {
				next.add(workspaceId);
			}
			return next;
		});
	};

	return (
		<nav
			aria-label="Sessions"
			className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4"
		>
			<h2 className="text-sm font-semibold">Sessions</h2>
			{tree.length === 0 && (
				<div className="text-xs text-gray-500">
					No workspaces in the catalog yet — create one in DSH web. There is
					no path fallback.
				</div>
			)}
			{tree.map((workspace) => {
				const isCollapsed = collapsed.has(workspace.id);
				return (
					<div key={workspace.id} className="flex flex-col">
						<button
							type="button"
							aria-expanded={!isCollapsed}
							onClick={() => toggle(workspace.id)}
							className="flex items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-medium text-slate-800 hover:bg-slate-100"
						>
							<span className="w-3 text-slate-400">
								{isCollapsed ? "▸" : "▾"}
							</span>
							<span>{workspace.title}</span>
							<span className="truncate text-xs font-normal text-slate-400">
								{workspace.path}
							</span>
						</button>
						{!isCollapsed && (
							<ul className="ml-3 flex flex-col border-l border-slate-200 pl-2">
								{workspace.sessions.map((session) => {
									const selected = session.id === selectedSessionId;
									return (
										<li key={session.id}>
											<button
												type="button"
												data-testid={`session-row-${session.id}`}
												aria-selected={selected}
												onClick={() => onSelect(session.id)}
												className={
													"w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs " +
													(selected
														? "bg-blue-100 font-semibold text-blue-800"
														: "text-slate-600 hover:bg-slate-100")
												}
											>
												{session.id}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				);
			})}
		</nav>
	);
}
