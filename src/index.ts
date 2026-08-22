/**
 * @dsh-demo/driver — DeepSeek Harness as a script.
 *
 * One-shot plugin on the `dsh-demo` profile (dsh-base only): the PRIMARY agent
 * (~deepseek/deepseek-v4-flash-latest) spawns agent A (openai/gpt-5.6-luna) to
 * generate a random integer, the driver branches on parity in plain TypeScript,
 * then spawns agent B (deepseek, n*9 -> b.txt) or agent C (gpt-5.6-luna,
 * n*10 -> c.txt). The primary reports the result; the driver exits 0/1.
 *
 * Orchestration is DIRECT: every child is a `subagents.start('spawn', ...)`
 * call from this file — no workflow script string, no vm sandbox. The driver
 * is the orchestrator; the subagent service supplies per-child provider/model
 * override and schema'd structured output.
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-cmdline";
import { APP_IDENTITY, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
	SubagentResult,
	SubagentRun,
	SubagentRuntime,
} from "@deepseek-ai/dsh-subagent";

// White-label the User-Agent every provider request sends: this process's
// `@deepseek-ai/dsh-llm` is the same module instance the pi-ai adapter reads
// per request, so mutating APP_IDENTITY in place replaces the default
// `deepseek-harness/...` attribution. Omit this block to keep the DSH default.
APP_IDENTITY.product = "opencode";
APP_IDENTITY.version = "1.18.11";
APP_IDENTITY.url = "https://opencode.ai";

/** Stable Cordis plugin name. */
export const name = "dsh-demo-driver";

/** Core services required before the one-shot run can start. */
export const inject = ["agents", "sessions", "subagents"];

/** Plugin config; no schema declared, so Cordis passes it through unvalidated. */
export interface Config {
	/** Directory b.txt/c.txt are written into (default: process.cwd()). */
	outputDir?: string;
	/** Abort the run after this many milliseconds (no timeout by default). */
	timeoutMs?: number;
}

const PROVIDER = "openrouter";
const MODEL_PRIMARY = "~deepseek/deepseek-v4-flash-latest";
const MODEL_A = "openai/gpt-5.6-luna";
const MODEL_B = "~deepseek/deepseek-v4-flash-latest";
const MODEL_C = "openai/gpt-5.6-luna";

/** The subagent provider every child runs on (registered by dsh-base). */
const SUBAGENT_PROVIDER = "spawn";

/** What the run produced, for the primary's final summary turn. */
interface RunSummary {
	number: number;
	odd: boolean;
	branch: string;
	file: string;
	value: number;
}

/** A structured-result schema for a single integer field. */
function intSchema(key: string): {
	type: "object";
	properties: Record<string, { type: "integer" }>;
	required: string[];
	additionalProperties: boolean;
} {
	return {
		type: "object",
		properties: { [key]: { type: "integer" } },
		required: [key],
		additionalProperties: false,
	};
}

/** Agent A's prompt: generate a random integer via bash, report via structured_output. */
const PROMPT_A =
	'Generate a truly random integer between 1 and 100 by running the bash tool with this exact command: node -e "console.log(Math.floor(Math.random()*100)+1)". Read the printed number from the tool result, then report it by calling the structured_output tool with {"number": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.';

/** Agent B/C's prompt: compute the product and write it to the file. */
function promptBc(
	number: number,
	factor: number,
	file: string,
	cwd: string,
): string {
	return (
		`The random number is ${number}. Compute ${number} * ${factor} = ? and write the result to ` +
		`${file} at the absolute path ${cwd}/${file} using the write tool. Then report your computed ` +
		'value by calling the structured_output tool with {"value": <the integer>}. Do not finish ' +
		"with plain text — only the structured_output tool call counts."
	);
}

/** Render any thrown value as a message string. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Last assistant text after the summary turn. */
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

/** Ask the primary agent to confirm the written file and summarize the run. */
async function summarize(
	agent: Agent,
	sessions: SessionStore,
	summary: RunSummary,
): Promise<void> {
	agent.followup(
		createUserMessage({
			content: [
				{
					type: "text",
					text: `The run finished. Random number: ${summary.number} (${summary.odd ? "odd" : "even"}). Agent ${summary.branch} computed ${summary.value} and wrote it to ${summary.file}. Confirm the file was written and summarize the run in one short message.`,
				},
			],
			source: { kind: "user" },
		}),
	);
	await agent.whenIdle();
	await sessions.flush(agent.session);
	const text = lastAssistantText(agent.session.events);
	if (text !== "") console.log(`[dsh-demo] primary agent: ${text}`);
}

/**
 * Print one child's live token stream and tool calls (session/event is the
 * live firehose, filtered to the child's session). Returns a disposer.
 */
function watchChild(
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
			// Prefix once per stream, then keep appending tokens to the same line.
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

/**
 * Start one child on the named provider/model and await its structured result.
 * The child must call `structured_output` explicitly (that is the only way the
 * schema'd value is captured); a plain-text finish yields no structured value.
 */
async function runChild(
	ctx: Context,
	subagents: SubagentRuntime,
	parent: Agent,
	label: string,
	prompt: string,
	model: string,
	schema: ReturnType<typeof intSchema>,
	signal: AbortSignal,
): Promise<SubagentResult> {
	console.log(`[${label}] started`);
	const run: SubagentRun = await subagents.start(SUBAGENT_PROVIDER, {
		label,
		prompt: [{ type: "text", text: prompt }],
		parent,
		signal,
		agentOptions: { provider: PROVIDER, model },
		outputSchema: schema,
	});
	const stopWatching = watchChild(ctx, run.id, label);
	try {
		const result = await run.result;
		if (result.stopReason !== "completed" || result.structured === undefined) {
			throw new Error(
				`agent ${label} ${result.stopReason}${result.diagnostic === undefined ? "" : `: ${result.diagnostic}`}`,
			);
		}
		console.log(`[${label}] completed`);
		return result;
	} finally {
		stopWatching();
		await run.dispose(); // reach child quiescence so the process can exit
	}
}

/** Drive the whole demo and return the process exit code. */
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
			"dsh-demo-driver: missing services (agents/sessions/subagents)",
		);
		return 1;
	}

	const cwd = config.outputDir ?? process.cwd();
	// One run-wide timeout signal; when it fires, the active child is cancelled.
	const signal =
		config.timeoutMs === undefined
			? new AbortController().signal
			: AbortSignal.timeout(config.timeoutMs);

	// PRIMARY agent (~deepseek/deepseek-v4-flash-latest); every child is its subagent.
	const { agent, dispose } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd },
		agentOptions: { provider: PROVIDER, model: MODEL_PRIMARY },
	});
	try {
		await agent.whenIdle();

		// --- agent A: generate the random number (openai/gpt-5.6-luna) ---
		const a = await runChild(
			ctx,
			subagents,
			agent,
			"A",
			PROMPT_A,
			MODEL_A,
			intSchema("number"),
			signal,
		);
		const number = (a.structured as { number: number }).number;

		// --- deterministic branch on parity (plain TS, no model involvement) ---
		const odd = number % 2 !== 0;
		const branch = odd ? "B" : "C";
		const factor = odd ? 9 : 10;
		const file = odd ? "b.txt" : "c.txt";
		const model = odd ? MODEL_B : MODEL_C;
		console.log(
			`[dsh-demo] random number = ${number} (${odd ? "odd" : "even"}) -> agent ${branch}`,
		);

		// --- agent B/C: compute and write the file ---
		const r = await runChild(
			ctx,
			subagents,
			agent,
			branch,
			promptBc(number, factor, file, cwd),
			model,
			intSchema("value"),
			signal,
		);
		const value = (r.structured as { value: number }).value;

		console.log(
			`[dsh-demo] agent ${branch} computed ${number} * ${factor} = ${value} -> ${file}`,
		);
		try {
			await summarize(agent, sessions, { number, odd, branch, file, value });
		} catch (error) {
			console.warn(
				`dsh-demo-driver: primary summary turn failed: ${messageOf(error)}`,
			);
		}
		return 0;
	} finally {
		await dispose();
	}
}

/** Mount the one-shot driver. */
export function apply(ctx: Context, config: Config | undefined): void {
	const exit = ctx.get("appExit");
	if (exit === undefined) {
		throw new Error(
			"dsh-demo-driver: the launcher must provide ctx.appExit before the tree mounts",
		);
	}
	void run(ctx, config ?? {}).then(exit, (error) => {
		console.error(`dsh-demo-driver: ${messageOf(error)}`);
		exit(1);
	});
}
