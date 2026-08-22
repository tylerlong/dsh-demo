/**
 * @dsh-demo/enhanced-flow — generic "task + review loop" driver.
 *
 * A task-agnostic enhanced workflow: the PRIMARY agent does the task from the
 * user's task + requirements; then a review loop runs until convergence:
 *
 *   1. a brand-new REVIEWER sub-agent (fresh spawn, no primary context)
 *      re-reads the same task + requirements + the final artifacts and gives
 *      structured feedback — it never redoes the task;
 *   2. the PRIMARY adjudicates every feedback (accept or reject) and fixes
 *      the artifacts for the accepted ones;
 *   3. if any feedback was accepted, the loop restarts with a NEW reviewer
 *      against the fixed artifacts; it stops when the reviewer has no more
 *      feedback or every feedback was rejected.
 *
 * Everything is config-driven (task, requirements, models, output dir, round
 * cap), so the same driver serves any task. The reviewer runs on its own
 * model (default openai/gpt-5.6-luna) and is restricted to read-only tools.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { APP_IDENTITY, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";

// White-label the User-Agent every provider request sends (same trick as the
// demo driver; omit to keep the DSH default).
APP_IDENTITY.product = "opencode";
APP_IDENTITY.version = "1.18.11";
APP_IDENTITY.url = "https://opencode.ai";

/** Stable Cordis plugin name. */
export const name = "dsh-demo-enhanced-flow";

/** Core services required before the run can start. */
export const inject = ["agents", "sessions", "subagents"];

/** Everything the enhanced flow needs; the user supplies task + requirements. */
export interface Config {
	/** What to do (any task). */
	task: string;
	/** Detailed (or brief) instructions and requirements for the task. */
	requirements: string;
	/** Model for the primary agent (default: deepseek/deepseek-v4-flash-0731). */
	primaryModel?: string;
	/** Model for every reviewer sub-agent (default: openai/gpt-5.6-luna). */
	reviewerModel?: string;
	/** Directory where the primary writes artifacts and reviewers inspect (default: process.cwd()). */
	outputDir?: string;
	/** Safety cap on review rounds (default: 5). */
	maxRounds?: number;
	/** Abort the run after this many milliseconds (no timeout by default). */
	timeoutMs?: number;
}

const PROVIDER = "openrouter";
const DEFAULT_PRIMARY = "deepseek/deepseek-v4-flash-0731";
const DEFAULT_REVIEWER = "openai/gpt-5.6-luna";
const SPAWN = "spawn";
/** Tool names the reviewer may use: read-only inspection, never mutation. */
const REVIEWER_TOOLS = ["read", "read_image", "glob", "grep"] as const;
/** Cap on embedded artifact bytes per round, to keep reviewer prompts sane. */
const MAX_EMBED_BYTES = 32 * 1024;

/** One reviewer feedback item. */
interface Feedback {
	issue: string;
	suggestion: string;
}

/** The reviewer's structured result: a list of feedback items. */
const feedbackSchema: {
	type: "object";
	properties: {
		feedbacks: {
			type: "array";
			items: {
				type: "object";
				properties: {
					issue: { type: "string" };
					suggestion: { type: "string" };
				};
				required: string[];
				additionalProperties: boolean;
			};
		};
	};
	required: string[];
	additionalProperties: boolean;
} = {
	type: "object",
	properties: {
		feedbacks: {
			type: "array",
			items: {
				type: "object",
				properties: {
					issue: { type: "string" },
					suggestion: { type: "string" },
				},
				required: ["issue", "suggestion"],
				additionalProperties: false,
			},
		},
	},
	required: ["feedbacks"],
	additionalProperties: false,
};

/** Render any thrown value as a message string. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Last assistant text in a session's events. */
function lastAssistantText(events: readonly SessionEvent[]): string {
	let started = false;
	let text = "";
	for (const event of events) {
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}

/**
 * Print one agent's live token stream and tool calls (session/event is the
 * live firehose, filtered to the agent's session). Returns a disposer.
 */
function watchAgent(
	ctx: Context,
	sessionId: SessionId,
	label: string,
): () => void {
	let streaming = false;
	return ctx.on("session/event", (session, event) => {
		if (session.id !== sessionId) return;
		if (
			event.type === "assistant/chunk" &&
			event.data.chunk.type === "text-delta"
		) {
			if (!streaming) {
				process.stdout.write(`\n[${label}] `);
				streaming = true;
			}
			process.stdout.write(event.data.chunk.text);
		} else if (event.type === "tool/call") {
			process.stdout.write(`\n[${label}] → tool ${event.data.name}\n`);
		} else if (event.type === "turn/end") {
			process.stdout.write("\n");
			streaming = false;
		}
	});
}

/** Send the primary one user message and wait for its turn to settle. */
async function primaryTurn(agent: Agent, text: string): Promise<void> {
	agent.followup(
		createUserMessage({
			content: [{ type: "text", text }],
			source: { kind: "user" },
		}),
	);
	await agent.whenIdle();
}

/**
 * List the artifacts the primary produced in the output dir and embed their
 * contents (capped) so the reviewer sees the final result directly.
 */
async function artifactReport(dir: string): Promise<string> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries.filter((e) => e.isFile()).map((e) => e.name);
	if (files.length === 0) return "(no files found in the output directory)";

	const parts: string[] = [];
	let budget = MAX_EMBED_BYTES;
	for (const file of files) {
		const path = join(dir, file);
		const content = await readFile(path, "utf8").catch(() => "<unreadable>");
		const truncated = content.length > budget;
		parts.push(
			`--- ${file} ---\n${truncated ? `${content.slice(0, budget)}\n…(truncated)` : content}`,
		);
		budget -= content.length;
		if (budget <= 0) break;
	}
	return parts.join("\n\n");
}

/** Build the reviewer prompt: same inputs as the primary had + final artifacts. */
function reviewerPrompt(config: Config, artifacts: string): string {
	return [
		"You are a REVIEWER. You must NOT redo the task. Review the final result produced by another agent and give feedback.",
		"",
		`TASK: ${config.task}`,
		`REQUIREMENTS: ${config.requirements}`,
		"",
		"FINAL RESULT / ARTIFACTS (in the output directory):",
		artifacts,
		"",
		"Inspect the artifacts and check them against the task and requirements. Report every issue you find.",
		'Call the structured_output tool with {"feedbacks": [{"issue": "...", "suggestion": "..."}]}.',
		'If the result fully satisfies the task and requirements, call structured_output with {"feedbacks": []}.',
		"Do not finish with plain text — only the structured_output tool call counts.",
	].join("\n");
}

/** Start one fresh reviewer sub-agent and resolve its structured feedback. */
async function runReviewer(
	ctx: Context,
	subagents: SubagentRuntime,
	parent: Agent,
	config: Config,
	signal: AbortSignal,
): Promise<Feedback[]> {
	console.log(`[reviewer] round start`);
	const run = await subagents.start(SPAWN, {
		label: "reviewer",
		prompt: [
			{
				type: "text",
				text: reviewerPrompt(
					config,
					await artifactReport(config.outputDir ?? process.cwd()),
				),
			},
		],
		parent,
		signal,
		agentOptions: {
			provider: PROVIDER,
			model: config.reviewerModel ?? DEFAULT_REVIEWER,
		},
		outputSchema: feedbackSchema,
		toolFilter: { allow: REVIEWER_TOOLS },
	});
	const stopWatching = watchAgent(ctx, run.id, "reviewer");
	try {
		const result = await run.result;
		if (result.stopReason !== "completed" || result.structured === undefined) {
			throw new Error(
				`reviewer ${result.stopReason}${result.diagnostic === undefined ? "" : `: ${result.diagnostic}`}`,
			);
		}
		const feedbacks = (result.structured as { feedbacks: Feedback[] })
			.feedbacks;
		console.log(
			`[reviewer] ${feedbacks.length === 0 ? "no more feedback" : `${feedbacks.length} feedback item(s)`}`,
		);
		return feedbacks;
	} finally {
		stopWatching();
		await run.dispose();
	}
}

/** Parse the primary's adjudication reply into accepted/rejected feedback ids. */
function parseDecisions(reply: string): {
	accepted: number[];
	rejected: number[];
} {
	const match = reply.match(/\{[\s\S]*\}/);
	if (match === null) return { accepted: [], rejected: [] };
	try {
		const data = JSON.parse(match[0]) as {
			accepted?: unknown;
			rejected?: unknown;
		};
		const ids = (value: unknown): number[] =>
			Array.isArray(value)
				? value.filter((v): v is number => typeof v === "number")
				: [];
		return { accepted: ids(data.accepted), rejected: ids(data.rejected) };
	} catch {
		return { accepted: [], rejected: [] };
	}
}

/**
 * Ask the primary to adjudicate the reviewer's feedback: accept or reject
 * each item, fix the artifacts for the accepted ones, and reply with a
 * machine-parseable decision block.
 */
async function adjudicate(
	agent: Agent,
	feedbacks: Feedback[],
	outputDir: string,
): Promise<{ accepted: number[]; rejected: number[] }> {
	const numbered = feedbacks
		.map(
			(f, i) => `${i + 1}. issue: ${f.issue}\n   suggestion: ${f.suggestion}`,
		)
		.join("\n");
	await primaryTurn(
		agent,
		[
			"A reviewer reviewed your work and gave this feedback:",
			"",
			numbered,
			"",
			`Adjudicate each feedback: ACCEPT (fix/adjust the artifacts in ${outputDir} accordingly) or REJECT (keep your work as-is).`,
			"Fix the artifacts for every feedback you accept, using the write/edit tools.",
			'Then reply with EXACTLY one line, nothing else: {"accepted": [<ids>], "rejected": [<ids>]}',
			'Example: {"accepted": [1, 3], "rejected": [2]}',
		].join("\n"),
	);
	return parseDecisions(lastAssistantText(agent.session.events));
}

/** Drive the whole enhanced flow and return the process exit code. */
async function run(ctx: Context, config: Config): Promise<number> {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const subagents = ctx.get("subagents");
	if (
		agents === undefined ||
		sessions === undefined ||
		subagents === undefined
	) {
		console.error(
			"dsh-demo-enhanced-flow: missing services (agents/sessions/subagents)",
		);
		return 1;
	}

	const outputDir = config.outputDir ?? process.cwd();
	const maxRounds = config.maxRounds ?? 5;
	const signal =
		config.timeoutMs === undefined
			? new AbortController().signal
			: AbortSignal.timeout(config.timeoutMs);

	// PRIMARY agent: does the task, then adjudicates + fixes each round.
	const { agent, dispose } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd: outputDir },
		agentOptions: {
			provider: PROVIDER,
			model: config.primaryModel ?? DEFAULT_PRIMARY,
		},
	});
	const stopWatching = watchAgent(ctx, agent.session.id, "primary");
	try {
		await agent.whenIdle();

		// 1. primary does the task from the user's inputs
		console.log(`[primary] starting task: ${config.task}`);
		await primaryTurn(
			agent,
			[
				`TASK: ${config.task}`,
				`REQUIREMENTS: ${config.requirements}`,
				`Work in the output directory ${outputDir} and write your final result/artifacts there.`,
				"When done, reply with a short summary of what you produced.",
			].join("\n"),
		);
		await sessions.flush(agent.session);
		console.log(
			`[primary] task done: ${lastAssistantText(agent.session.events)}`,
		);

		// 2. review loop until convergence
		for (let round = 1; round <= maxRounds; round += 1) {
			console.log(`[loop] round ${round}/${maxRounds}`);
			const feedbacks = await runReviewer(
				ctx,
				subagents,
				agent,
				config,
				signal,
			);
			if (feedbacks.length === 0) {
				console.log("[loop] reviewer has no more feedback — converged");
				break;
			}

			const { accepted, rejected } = await adjudicate(
				agent,
				feedbacks,
				outputDir,
			);
			await sessions.flush(agent.session);
			console.log(
				`[loop] primary accepted ${accepted.length}, rejected ${rejected.length} of ${feedbacks.length} feedback item(s)`,
			);
			if (accepted.length === 0) {
				console.log("[loop] all feedback rejected — stopping");
				break;
			}
			// any accepted → restart the loop with a brand-new reviewer
		}

		console.log("[dsh-demo] enhanced flow finished");
		return 0;
	} finally {
		stopWatching();
		await dispose();
	}
}

/** Mount the one-shot enhanced-flow driver. */
export function apply(ctx: Context, config: Config | undefined): void {
	const exit = ctx.get("appExit");
	if (exit === undefined) {
		throw new Error(
			"dsh-demo-enhanced-flow: the launcher must provide ctx.appExit before the tree mounts",
		);
	}
	void run(ctx, config ?? ({} as Config)).then(exit, (error) => {
		console.error(`dsh-demo-enhanced-flow: ${messageOf(error)}`);
		exit(1);
	});
}
