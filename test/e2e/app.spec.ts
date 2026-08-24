import { expect, type Page, test } from "@playwright/test";

/**
 * harness-workflow end-to-end tests against the real server (see playwright.config.ts).
 *
 * These pin the actual browser experience: the page must load without console
 * errors, the WebSocket must connect, the model dropdowns must populate from
 * /api/models, the read-only session tree must populate from /api/sessions
 * (parent ticket #37) with the latest session preselected, and a submitted run
 * must continue the selected session, start both lanes, and reach a terminal
 * state (done or canceled) with the UI returning to an unlocked state and no
 * comparison summary (the orchestrator is never invoked).
 *
 * The selectors are the React DOM's roles and test ids (the session browser,
 * ticket #41, renders the workspace → sessions tree, the transcript panel, and
 * the run form; the run lifecycle hook, ticket #33, renders the connection
 * status, the run status, and the two lanes with data-testid attributes; the
 * form controls are queried by their accessible roles). The tree is seeded
 * once on page load from the shared session store, so these tests need at
 * least one registered session in the local harness home (~/.dsh) — the same
 * catalog DSH web shows. The empty-catalog guard is covered by stubbing
 * /api/sessions with an empty tree (see "empty session catalog"), because the
 * live shared store is never empty in a working install. The workspace
 * dropdown no longer exists (parent #37): the run continues the session
 * selected in the tree, so the form has no workspace picker and submit stays
 * disabled until a session is selected.
 *
 * LOCAL-ONLY by design: they boot the real app (pnpm serve) against the real
 * harness and ~/.dsh credentials, and are not part of CI (CI runs vitest only).
 */
const FAST_TASK = "Reply with the single word: ready";

/** Session rows as served by /api/sessions (mirror of the SessionTree shape). */
interface SessionRow {
	id: string;
	updatedAt: number;
}

interface WorkspaceRow {
	id: string;
	path: string;
	title: string;
	sessions: SessionRow[];
}

/**
 * The repo directory harness-workflow itself runs in. Its workspace in the
 * shared store holds the live/current DSH session, which these run-form tests
 * must NEVER resume — continuing it appends the e2e task to the session the
 * maintainer is actively working in. See {@link safeTargetSession}.
 */
const REPO_PATH = process.cwd();

/**
 * A deterministic session to resume for a submitted run, chosen so it never
 * touches the live session in this repo's own workspace. Prefers a non-repo
 * workspace whose path references the langchain-demo fixture; otherwise the
 * registry-first non-repo workspace's newest session (workspaces keep durable
 * registry order, never date-sorted). undefined only when every registered
 * workspace is this repo's — the run-form tests then fail fast rather than
 * resume the live session.
 */
function safeTargetSession(
	tree: readonly WorkspaceRow[],
): SessionRow | undefined {
	const otherWorkspaces = tree.filter(
		(workspace) => workspace.path !== REPO_PATH,
	);
	if (otherWorkspaces.length === 0) {
		return undefined;
	}
	const fixture = otherWorkspaces.find((workspace) =>
		workspace.path.includes("langchain-demo"),
	);
	// sessions[0] is the workspace's newest (the tree sorts by updatedAt desc).
	return (fixture ?? otherWorkspaces[0])?.sessions[0];
}

/**
 * The latest session across the whole tree (the page's read-only preselect
 * rule). Used only to ASSERT what the UI preselects — never as a submission
 * target, which would resume the live session.
 */
function latestSession(tree: readonly WorkspaceRow[]): SessionRow | undefined {
	let latest: SessionRow | undefined;
	for (const workspace of tree) {
		for (const session of workspace.sessions) {
			if (latest === undefined || session.updatedAt > latest.updatedAt) {
				latest = session;
			}
		}
	}
	return latest;
}

/**
 * Fetch the tree and click the safe (non-live) target row, asserting it
 * becomes selected. Shared by the run-form tests so none of them ever resumes
 * the live session without repeating this block.
 */
async function selectSafeSession(page: Page): Promise<SessionRow> {
	const tree = (await (
		await page.request.get("/api/sessions")
	).json()) as readonly WorkspaceRow[];
	const target = safeTargetSession(tree);
	if (target === undefined) {
		throw new Error(
			"no non-live session to continue; refusing to resume the live session",
		);
	}
	await page.getByTestId(`session-row-${target.id}`).click();
	await expect(page.getByTestId(`session-row-${target.id}`)).toHaveAttribute(
		"aria-current",
		"true",
	);
	return target;
}

test("page loads, WS connects, model dropdowns populate, session tree renders, no console errors", async ({
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

	// The session tree is seeded from the shared store: one row per session,
	// labeled by id, under its workspace.
	const tree = (await (
		await page.request.get("/api/sessions")
	).json()) as readonly WorkspaceRow[];
	expect(tree.length).toBeGreaterThan(0);
	const allSessions = tree.flatMap((w) => w.sessions);
	expect(allSessions.length).toBeGreaterThan(0);
	for (const session of allSessions) {
		await expect(page.getByTestId(`session-row-${session.id}`)).toBeVisible();
	}

	// The workspace dropdown is gone (parent #37): no workspace picker.
	await expect(
		page.getByRole("combobox", { name: "Workspace" }),
	).not.toBeVisible();

	// The latest session is preselected, so submit is usable.
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

	// No console or page errors — a syntax error in the served script would
	// fail here (regression: the inline script must parse).
	expect(errors).toEqual([]);
});

test("preselects the latest session (read-only) and continues a safe session through the run form", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// The tree renders; the latest session is preselected and highlighted.
	// This assertion is read-only — it never resumes the latest (live) session.
	const tree = (await (
		await page.request.get("/api/sessions")
	).json()) as readonly WorkspaceRow[];
	const latest = latestSession(tree);
	expect(latest).toBeDefined();
	if (latest === undefined) throw new Error("expected a session in the tree");
	await expect(page.getByTestId(`session-row-${latest.id}`)).toHaveAttribute(
		"aria-current",
		"true",
	);

	// Continue a SAFE session (a second workspace's, never this repo's live
	// session): click its row, then run the form through to done.
	await selectSafeSession(page);

	// The task field starts empty; typing arms the run on the selected session.
	await expect(page.getByLabel("Task")).toHaveValue("");
	await page.getByLabel("Task").fill(FAST_TASK);
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

	// The transcript panel shows the continued session's output read from the
	// store (parent #37): the primary agent's panel is populated.
	await expect(page.getByTestId("transcript-primary")).not.toBeEmpty({
		timeout: 30_000,
	});

	// Inputs are unlocked again after the run.
	await expect(page.getByLabel("Task")).toBeEnabled();
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

	expect(errors).toEqual([]);
});

test("the submitted question shows as the primary input and both lane answers stream in and persist after the run", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// Continue a safe (non-live) session so the run never resumes this repo's
	// live session.
	await selectSafeSession(page);

	// Submit a real question; the primary panel shows it as its input line
	// (the resumed orchestrator is never driven, so the question lives in the
	// task, not in the stored primary session — regression: the primary used
	// to render nothing after a run, and the lane windows showed the injected
	// workspace context instead of the answers, then vanished at run end).
	const task = "What is your AI model?";
	await page.getByLabel("Task").fill(task);
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
	await page.getByRole("button", { name: "Submit" }).click();

	// The task appears as the primary's input line.
	await expect(page.getByTestId("transcript-primary")).toContainText(task, {
		timeout: 30_000,
	});

	// Both lane answers stream in over the socket (lane/worker/delta) and
	// render as the two worker windows, each with the real answer — not the
	// injected workspace context that used to dominate the store-read child
	// session windows (regression: the "irrelevant transcript" symptom).
	const workers = page.getByTestId("transcript-worker");
	await expect(workers).toHaveCount(2, { timeout: 60_000 });
	for (let i = 0; i < 2; i++) {
		await expect(workers.nth(i)).not.toBeEmpty();
		await expect(workers.nth(i)).not.toContainText("CONTEXT.md", {
			timeout: 5_000,
		});
		await expect(workers.nth(i)).not.toContainText("Agent skills");
		await expect(workers.nth(i)).not.toContainText("workspace instructions");
	}

	// Both lanes complete, and the answers persist after the run ends (they
	// are no longer cleared when the run settles).
	await expect(page.getByTestId("primary-status")).toContainText("done", {
		timeout: 120_000,
	});
	await expect(page.getByTestId("lane-left-status")).toContainText("done");
	await expect(page.getByTestId("lane-right-status")).toContainText("done");
	await expect(page.getByTestId("transcript-worker")).toHaveCount(2);
	await expect(workers.nth(0)).not.toBeEmpty();
	await expect(workers.nth(1)).not.toBeEmpty();

	expect(errors).toEqual([]);
});

test("walking the tree switches the transcript and the watched session", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// Click a safe session: its row highlights and the transcript panel shows
	// that session's output.
	const target = await selectSafeSession(page);
	await expect(page.getByTestId("transcript-session")).toContainText(target.id);
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

	// Continue a safe (non-live) session so the run never resumes this repo's
	// live session.
	await selectSafeSession(page);

	const LONG_TASK =
		"Write a detailed 1000-word essay about the history of computing from 1940 to the present, covering hardware, software, and the internet.";
	await page.getByLabel("Task").fill(LONG_TASK);
	await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();
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

test("empty session catalog disables submit and shows the hint", async ({
	page,
}) => {
	// The live shared store is never empty in a working install, so stub the
	// seam at the browser level: the page receives an empty tree from
	// /api/sessions. No server code changes; model loading still hits the real
	// endpoint. This is the same empty-catalog state the page must survive.
	await page.route("**/api/sessions", (route) =>
		route.fulfill({ status: 200, json: [] }),
	);

	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// No session rows at all; the hint explains the catalog is empty.
	await expect(
		page.getByText(/No workspaces in the catalog yet/),
	).toBeVisible();

	// Submit stays disabled, even after typing a task (no free-text path
	// fallback: a run cannot start without a selected session).
	const submit = page.getByRole("button", { name: "Submit" });
	await expect(submit).toBeDisabled();
	await page.getByLabel("Task").fill(FAST_TASK);
	await expect(submit).toBeDisabled();

	expect(errors).toEqual([]);
});
