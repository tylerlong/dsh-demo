import { expect, test } from "@playwright/test";

/**
 * dsh-compare end-to-end tests against the real server (see playwright.config.ts).
 *
 * These pin the actual browser experience: the page must load without console
 * errors, the WebSocket must connect, the model dropdowns must populate from
 * /api/models, and a submitted run must start both lanes, stream output, and
 * reach a terminal state (done or canceled) with the UI returning to an
 * unlocked state.
 */

/** A tiny task: fast models finish it in well under a second. */
const FAST_TASK = "Reply with the single word: ready";

/** A longer task: slow enough that a run is still in flight when we cancel. */
const LONG_TASK =
	"Write a detailed 1000-word essay about the history of computing from 1940 to the present, covering hardware, software, and the internet.";

/**
 * The workspace used for runs in these tests. The playwright webServer boots
 * pnpm serve with the repo as its cwd, so this resolves to an existing folder.
 */
const WORKSPACE = ".";

test("page loads, WS connects, dropdowns populate, workspace input, no console errors", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push("console.error: " + msg.text());
	});

	await page.goto("/");

	// The WebSocket connects and the status flips to "connected".
	await expect(page.locator("#conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// All three dropdowns populate from /api/models (the harness model list).
	const primaryCount = await page.locator("#primary-model option").count();
	expect(primaryCount).toBeGreaterThan(0);
	await expect(page.locator("#lane-left-model option")).toHaveCount(
		primaryCount,
	);
	await expect(page.locator("#lane-right-model option")).toHaveCount(
		primaryCount,
	);

	// The workspace input is present and empty by default; submit starts disabled
	// and enables only once a workspace is entered.
	await expect(page.locator("#workspace")).toBeVisible();
	await expect(page.locator("#workspace")).toHaveValue("");
	await expect(page.locator("#submit")).toBeDisabled();
	await page.fill("#workspace", WORKSPACE);
	await expect(page.locator("#submit")).toBeEnabled();

	// No console or page errors — a syntax error in the served script would
	// fail here (regression: the inline script must parse; the localforage UMD
	// build must also load without throwing).
	expect(errors).toEqual([]);
});

test("submit runs the full comparison: both lanes done, no summary, inputs unlock", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.locator("#conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	await page.fill("#task", FAST_TASK);
	await page.fill("#workspace", WORKSPACE);
	await expect(page.locator("#submit")).toBeEnabled();
	await page.click("#submit");

	// The run reaches a terminal "done" state (fast models may finish before
	// the UI's 1s timer ticks, so don't require observing "running").
	await expect(page.locator("#primary-status")).toContainText("done", {
		timeout: 120_000,
	});

	// Both lanes completed with a done chip.
	await expect(page.locator("#lane-left-status")).toContainText("done");
	await expect(page.locator("#lane-right-status")).toContainText("done");

	// The top section shows the run-level spawn notice, not a model summary
	// (no run/summary is produced; the orchestrator is never invoked).
	const primaryOutput = await page.locator("#primary-output").textContent();
	expect(primaryOutput ?? "").not.toBe("");

	// Inputs are unlocked again after the run.
	await expect(page.locator("#task")).toBeEnabled();
	await expect(page.locator("#submit")).toBeEnabled();

	expect(errors).toEqual([]);
});

test("cancel aborts a running comparison and returns the UI to idle", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

	await page.goto("/");
	await expect(page.locator("#conn-status")).toHaveText("connected", {
		timeout: 15_000,
	});

	// A long task keeps the run in flight so we can cancel it.
	await page.fill("#task", LONG_TASK);
	await page.fill("#workspace", WORKSPACE);
	await page.click("#submit");

	// Both lanes start (running chips) — the run is genuinely in progress.
	await expect(page.locator("#lane-left-status")).toContainText("running", {
		timeout: 120_000,
	});
	await expect(page.locator("#lane-right-status")).toContainText("running", {
		timeout: 120_000,
	});

	// Cancel aborts the whole run; the UI returns to an unlocked idle state.
	await page.click("#cancel");
	await expect(page.locator("#primary-status")).toContainText("canceled", {
		timeout: 60_000,
	});
	await expect(page.locator("#task")).toBeEnabled();
	await expect(page.locator("#submit")).toBeEnabled();

	expect(errors).toEqual([]);
});
