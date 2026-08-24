import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
 * form controls are queried by their accessible roles).
 *
 * ISOLATED STORE: the suite runs against a throwaway harness home
 * (test/e2e/.home, seeded by global-setup.ts), never the real ~/.dsh. The
 * tree is seeded once on page load from that isolated store, which always
 * holds exactly one fixture workspace with one fixture session
 * (session-e2e-fixture). The empty-catalog guard is covered by stubbing
 * /api/sessions with an empty tree (see "empty session catalog"). The
 * workspace dropdown no longer exists (parent #37): the run continues the
 * session selected in the tree, so the form has no workspace picker and submit
 * stays disabled until a session is selected.
 *
 * LOCAL-ONLY by design: they boot the real app (pnpm serve) against the local
 * harness checkout and real model credentials (settings + credentials copied
 * into the isolated home), and are not part of CI (CI runs vitest only).
 */

/** The isolated harness home the suite's server boots with (see playwright.config.ts). */
const ISOLATED_HOME = fileURLToPath(new URL("./.home", import.meta.url));

/**
 * A stable fingerprint of one store file: its path relative to the isolated
 * home plus size + mtimeMs. Cheap and sufficient to detect any write.
 */
function storeFingerprint(): string {
	const entries: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				walk(path);
			} else {
				entries.push(
					`${relative(ISOLATED_HOME, path)}:${stat.size}:${stat.mtimeMs}`,
				);
			}
		}
	};
	walk(ISOLATED_HOME);
	return entries.sort().join("\n");
}

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
 * The repo directory harness-workflow itself runs in. Defense-in-depth: the
 * run-form tests still refuse to resume a session whose workspace IS this repo
 * path, even though the isolated store's only workspace is the fixture folder
 * under test/e2e/fixtures — never this directory.
 */
const REPO_PATH = process.cwd();

/**
 * A deterministic session to resume for a submitted run. In the isolated
 * store this is always the fixture session: the fixture workspace's path is
 * not the repo root, so it passes the guard below. undefined only when the
 * tree is empty — the run-form tests then fail fast.
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
 * target.
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
 * Fetch the tree and click the safe target row, asserting it becomes selected.
 * Shared by the run-form tests so none of them repeats this block.
 */
async function selectSafeSession(page: Page): Promise<SessionRow> {
	const tree = (await (
		await page.request.get("/api/sessions")
	).json()) as readonly WorkspaceRow[];
	const target = safeTargetSession(tree);
	if (target === undefined) {
		throw new Error("no session to continue in the isolated store");
	}
	await page.getByTestId(`session-row-${target.id}`).click();
	await expect(page.getByTestId(`session-row-${target.id}`)).toHaveAttribute(
		"aria-current",
		"true",
	);
	return target;
}

test("read-only session reads never write to the isolated store", async ({
	page,
	request,
}) => {
	// The store reads (GET /api/sessions and GET /api/sessions/:id/transcript)
	// must be strictly read-only: the app must never write to session files
	// directly, and the suite must prove it against the store it actually
	// serves. The isolated home is the only store the server can write, so a
	// fingerprint before/after the reads catching any change is a real write.
	await page.goto("/");
	await expect(page.getByTestId("conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// Prime the read paths once (lazy init), then settle so the baseline is
	// taken after any one-time server-side initialization, not during it.
	const tree = (await (
		await request.get("/api/sessions")
	).json()) as readonly WorkspaceRow[];
	expect(tree.length).toBeGreaterThan(0);
	const sessionId = tree[0]?.sessions[0]?.id;
	expect(sessionId).toBeDefined();
	await request.get(`/api/sessions/${sessionId}/transcript`);
	await page.waitForTimeout(1_000);

	const before = storeFingerprint();
	// Drive the reads again — the exact paths the browser uses on load and on
	// session selection.
	await request.get("/api/sessions");
	await request.get(`/api/sessions/${sessionId}/transcript`);
	const after = storeFingerprint();

	expect(after).toEqual(before);
});

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
