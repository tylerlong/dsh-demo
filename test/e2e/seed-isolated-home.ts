/**
 * seed-isolated-home.ts — build the throwaway harness home the e2e suite runs
 * against. Run as the first half of the Playwright webServer command (see
 * playwright.config.ts) with `tsx --expose-internals` (the app's boot needs
 * the internal module loader to resolve bare `@deepseek-ai/*` specifiers from
 * the DSH monorepo), so the server only ever boots against an already-seeded
 * home.
 *
 * Rebuilds `test/e2e/.home` from scratch: copies settings + credentials from
 * the real `~/.dsh`, then boots the shared harness against it and creates one
 * fixture workspace + session through DSH's own services. The suite's server
 * process boots with `DSH_HOME` pointed here, so every write the tests cause
 * lands in this throwaway home — never in the store DSH web owns.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionId } from "@deepseek-ai/dsh-session";
import { bootHarness } from "../../src/boot.ts";

/** The repo's e2e fixture workspace folder (a real directory workers can read). */
const FIXTURE_WORKSPACE = fileURLToPath(
	new URL("./fixtures/workspace", import.meta.url),
);

/** The isolated harness home this suite boots against (gitignored, throwaway). */
const ISOLATED_HOME = fileURLToPath(new URL("./.home", import.meta.url));

/** The fixture session the run-form tests resume. */
const FIXTURE_SESSION_ID = "session-e2e-fixture";

/** Copy one file from the real home into the isolated home; missing → throw. */
function copyHomeFile(name: string): void {
	const src = join(homedir(), ".dsh", name);
	if (!existsSync(src)) {
		throw new Error(
			`e2e seed: ${src} is missing; the suite needs the real harness home's ${name} to resolve model providers`,
		);
	}
	cpSync(src, join(ISOLATED_HOME, name));
}

/** A minimal valid conversation the fixture session is seeded with. The
 * session store auto-seeds the permission/sandbox/approval events on create,
 * so only the conversation itself is appended here. The assistant message
 * needs a full model source (provider + model) to pass event-shape replay
 * validation. */
function fixtureEvents(): Array<{
	type: string;
	data: Record<string, unknown>;
	surfaceOp?: "append";
}> {
	return [
		{
			type: "user/message",
			data: {
				id: "e2e-fixture-msg-1",
				role: "user",
				content: [{ type: "text", text: "Hello" }],
				source: { kind: "user" },
			},
			surfaceOp: "append",
		},
		{ type: "turn/start", data: { turn: 1 } },
		{
			type: "assistant/message",
			data: {
				turn: 1,
				message: {
					id: "e2e-fixture-msg-2",
					role: "assistant",
					content: [{ type: "text", text: "Hi there" }],
					source: { kind: "model", provider: "dry-run", model: "fixture" },
				},
			},
			surfaceOp: "append",
		},
		{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
	];
}

/** Find the fixture session's log file under the isolated home's sessions root. */
function findFixtureLog(): string | undefined {
	const sessionsRoot = join(ISOLATED_HOME, "sessions");
	if (!existsSync(sessionsRoot)) return undefined;
	for (const project of readdirSync(sessionsRoot)) {
		const projectDir = join(sessionsRoot, project);
		const sessionDir = join(projectDir, FIXTURE_SESSION_ID);
		if (existsSync(join(sessionDir, "session.jsonl.zstd"))) {
			return join(sessionDir, "session.jsonl.zstd");
		}
	}
	return undefined;
}

// Rebuild the isolated home from scratch every run: no state leaks between
// suites, and a previous run's resumed fixture session can never be read.
rmSync(ISOLATED_HOME, { recursive: true, force: true });
mkdirSync(ISOLATED_HOME, { recursive: true });
copyHomeFile("settings.yaml");
copyHomeFile(".credentials.yaml");

// The fixture workspace folder must exist (the registry realpath-canonicalizes
// it, and lane workers read from it). Keep it free of the strings the e2e
// transcript assertions pin against (CONTEXT.md / Agent skills / workspace
// instructions).
mkdirSync(FIXTURE_WORKSPACE, { recursive: true });
writeFileSync(
	join(FIXTURE_WORKSPACE, "README.md"),
	"# harness-workflow e2e fixture workspace\n\nRead-only fixture content for the isolated end-to-end suite.\n",
);

// Boot the shared harness against the isolated home and create the fixture
// workspace + session through DSH's own services, so the store files are
// exactly what the app itself would produce.
process.env.DSH_HOME = ISOLATED_HOME;
const ctx = await bootHarness();
try {
	await ctx.get("loader")?.await();
	const workspace = await ctx.workspaceRegistry.create(
		FIXTURE_WORKSPACE,
		"e2e-fixture",
	);
	const session = ctx.sessions.create(SessionId(FIXTURE_SESSION_ID), {
		meta: { cwd: FIXTURE_WORKSPACE },
	});
	for (const event of fixtureEvents()) {
		session.append(event.type, event.data, {
			surfaceOp: event.surfaceOp,
		});
	}
	await ctx.sessions.flush(session);
	await workspace.attachSession(session.id);
} finally {
	await ctx.fiber.dispose();
}

// Sanity: the fixture session landed under the isolated home with the id the
// tests expect (the real home is never on the path).
if (findFixtureLog() === undefined) {
	throw new Error(
		`e2e seed: fixture session "${FIXTURE_SESSION_ID}" was not persisted under ${ISOLATED_HOME}/sessions`,
	);
}
console.log(`e2e seed: isolated home ready at ${ISOLATED_HOME}`);
