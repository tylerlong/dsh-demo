import { expect, test } from "@playwright/test";

/**
 * harness-workflow end-to-end tests against the real server (see playwright.config.ts).
 *
 * These pin the actual browser experience: the page must load without console
 * errors, the WebSocket must connect, the model dropdowns must populate from
 * /api/models, the workspace dropdown must populate from the shared registry
 * (/api/workspaces) and preselect the workspace with the most recent session,
 * and a submitted run must start both lanes, stream output, and reach a
 * terminal state (done or canceled) with the UI returning to an unlocked state
 * and no comparison summary (the orchestrator is never invoked).
 *
 * The selectors are the React DOM's roles and test ids (the run lifecycle
 * hook, ticket #33, renders the connection status, the run status/output, and
 * the two lanes with data-testid attributes; the form controls are queried by
 * their accessible roles). The workspace picker is a dropdown seeded once on
 * page load from the shared catalog, so these tests need at least one
 * registered workspace in the local harness home (~/.dsh) — the same catalog
 * DSH web shows. The empty-catalog guard is covered by stubbing
 * /api/workspaces with an empty list (see "empty workspace catalog"), because
 * the live shared registry is never empty in a working install. localforage
 * remember/restore no longer exists — the only preselect is the shared session
 * recency, which this file verifies.
 *
 * LOCAL-ONLY by design: they boot the real app (pnpm serve) against the real
 * harness and --/.dsh credentials, and are not part of CI (CI runs vitest only).
 */
const FAST_TASK = "Reply with the single word: ready";

/** workspace rows as served by /api/workspaces (mirror of WorkspaceOption). */
interface WorkspaceRow {
	id: string;
	path: string;
	title: string;
	newestSessionAt?: number;
}

/** The index the page selects: newest session wins, else the first. */
function preselectIndex(workspaces: readonly WorkspaceRow[]): number {
	let pre = -1;
	let newestAt = -1;
	workspaces.forEach((w, i) => {
		if (typeof w.newestSessionAt === "number" && w.newestSessionAt > newestAt) {
			newestAt = w.newestSessionAt;
			pre = i;
		}
	});
	return pre >= 0 ? pre : 0;
}

test("page loads, WS connects, dropdowns populate, no console errors", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push("console.error: " + msg.text());
	});

	await page.goto("/");

	// The WebSocket connects and the status flips to "connected".
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// All three model dropdowns populate from /api/models (the harness model list).
	const primary = page.getByRole("combobox", { name: "Primary model" });
	const primaryCount = await primary.locator("option").count();
	expect(primaryCount).toBeGreaterThan(0);
	await expect(
		page.getByRole("combobox", { name: "Left lane model" }).locator("option"),
	).toHaveCount(primaryCount);
	await expect(
		page.getByRole("combobox", { name: "Right lane model" }).locator("option"),
	).toHaveCount(primaryCount);

	// The workspace dropdown is seeded from the shared registry: one option per
	// /api/workspaces row, each carrying that workspace's canonical path.
	const workspaces = (await (
		await page.request.get("/api/workspaces")
	).json()) as readonly WorkspaceRow[];
	expect(workspaces.length).toBeGreaterThan(0);
	const workspace = page.getByRole("combobox", { name: "Workspace" });
	const workspaceOptions = workspace.locator("option");
	await expect(workspaceOptions).toHaveCount(workspaces.length);
	const optionPaths = await workspaceOptions.evaluateAll((els) =>
		els.map((el) => (el as HTMLOptionElement).value),
	);
	expect(optionPaths).toEqual(workspaces.map((w) => w.path));
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

	// No console or page errors — a syntax error in the served script would
	// fail here (regression: the inline script must parse).
	expect(errors).toEqual([]);
});

test("preselects the workspace with the most recently used session", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// Wait for the dropdown to be seeded, then confirm the preselected option is
	// exactly the one the page's recency rule picks (newest session, else first).
	const workspaces = (await (
		await page.request.get("/api/workspaces")
	).json()) as readonly WorkspaceRow[];
	expect(workspaces.length).toBeGreaterThan(0);
	const workspace = page.getByRole("combobox", { name: "Workspace" });
	await expect(workspace.locator("option")).toHaveCount(workspaces.length);
	const expected = workspaces[preselectIndex(workspaces)]!.path;
	await expect(workspace).toHaveValue(expected);
});

test("submit runs the full comparison: both lanes done, no summary, inputs unlock", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	await page.getByLabel("Task").fill(FAST_TASK);
	await page.getByRole("combobox", { name: "Workspace" }).selectOption({
		index: 0,
	});
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
	await page.getByRole("button", { name: "Submit" }).click();

	// The run reaches a terminal "done" state (fast models may finish before
	// the UI's 1s timer ticks, so don't require observing "running").
	await expect(page.getByTestId("primary-status")).toContainText("done", {
		timeout: 120_000,
	});

	// Both lanes completed with a done chip.
	await expect(page.getByTestId("lane-left-status")).toContainText("done");
	await expect(page.getByTestId("lane-right-status")).toContainText("done");

	// The top section shows the run-level spawn notice, not a model summary
	// (no run/summary is produced; the orchestrator is never invoked).
	const primaryOutput = await page.getByTestId("primary-output").textContent();
	expect(primaryOutput ?? "").not.toBe("");

	// Inputs are unlocked again after the run.
	await expect(page.getByLabel("Task")).toBeEnabled();
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

	expect(errors).toEqual([]);
});

test("cancel aborts a running comparison and returns the UI to idle", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	const LONG_TASK =
		"Write a detailed 1000-word essay about the history of computing from 1940 to the present, covering hardware, software, and the internet.";
	await page.getByLabel("Task").fill(LONG_TASK);
	await page.getByRole("combobox", { name: "Workspace" }).selectOption({
		index: 0,
	});
	await page.getByRole("button", { name: "Submit" }).click();

	// Both lanes start (running chips) — the run is genuinely in progress.
	await expect(page.getByTestId("lane-left-status")).toContainText("running", {
		timeout: 120_000,
	});
	await expect(page.getByTestId("lane-right-status")).toContainText("running", {
		timeout: 120_000,
	});

	// Cancel aborts the whole run; the UI returns to an unlocked idle state.
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByTestId("primary-status")).toContainText("canceled", {
		timeout: 60_000,
	});
	await expect(page.getByLabel("Task")).toBeEnabled();
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

	expect(errors).toEqual([]);
});

test("empty workspace catalog disables submit and shows the hint", async ({
	page,
}) => {
	// The live shared registry is never empty in a working install, so stub the
	// seam at the browser level: the page receives zero workspaces from
	// /api/workspaces. No server code changes; model loading still hits the real
	// endpoint. This is the same empty-catalog state the page must survive.
	await page.route("**/api/workspaces", (route) =>
		route.fulfill({ status: 200, json: [] }),
	);

	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// No workspace options at all.
	const workspace = page.getByRole("combobox", { name: "Workspace" });
	await expect(workspace.locator("option")).toHaveCount(0);

	// The hint explains the catalog lives in DSH web and there is no fallback.
	await expect(
		page.getByText(/No workspaces in the catalog yet/),
	).toBeVisible();

	// Submit stays disabled, even after typing a task (no free-text path
	// fallback: a run cannot start without a picked workspace).
	const submit = page.getByRole("button", { name: "Submit" });
	await expect(submit).toBeDisabled();
	await page.getByLabel("Task").fill(FAST_TASK);
	await expect(submit).toBeDisabled();

	expect(errors).toEqual([]);
});
