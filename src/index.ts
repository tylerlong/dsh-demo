/**
 * The first demo, standalone: a DSH agent script with no plugin shape.
 *
 * The PRIMARY agent (deepseek/deepseek-v4-flash-0731) spawns agent A
 * (openai/gpt-5.6-luna) to generate a random integer; the script branches on
 * parity in plain TypeScript, then spawns agent B (deepseek, n*9 -> b.txt) or
 * agent C (openai/gpt-5.6-luna, n*10 -> c.txt). The primary reports the result.
 *
 * Orchestration is DIRECT: every child is a `subagents.start('spawn', ...)`
 * call — no workflow script string, no vm sandbox.
 *
 * Run with:  pnpm demo
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { APP_IDENTITY, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { bootHarness, shutdown } from "./boot.ts";

// White-label the User-Agent every provider request sends.
APP_IDENTITY.product = "opencode";
APP_IDENTITY.version = "1.18.11";
APP_IDENTITY.url = "https://opencode.ai";

const PROVIDER = "openrouter";
const PRIMARY = "deepseek/deepseek-v4-flash-0731";
const MODEL_A = "openai/gpt-5.6-luna";
const MODEL_B = "deepseek/deepseek-v4-flash-0731";
const MODEL_C = "openai/gpt-5.6-luna";
const SPAWN = "spawn";

/** Structured-result schema: one required integer property. */
type IntSchema = {
	type: "object";
	properties: Record<string, { type: "integer" }>;
	required: string[];
	additionalProperties: boolean;
};
const int = (key: string): IntSchema => ({
	type: "object",
	properties: { [key]: { type: "integer" } },
	required: [key],
	additionalProperties: false,
});

const PROMPT_A =
	'Generate a truly random integer between 1 and 100 by running the bash tool with this exact command: node -e "console.log(Math.floor(Math.random()*100)+1)". Read the printed number from the tool result, then report it by calling the structured_output tool with {"number": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.';

function promptBC(
	number: number,
	factor: number,
	file: string,
	cwd: string,
): string {
	return `The random number is ${number}. Compute ${number} * ${factor} = ? and write the result to ${file} at the absolute path ${cwd}/${file} using the write tool. Then report your computed value by calling the structured_output tool with {"value": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.`;
}

/** Spawn one child, stream its tokens live, resolve to the schema value. */
async function child(
	ctx: Context,
	subagents: SubagentRuntime,
	parent: Agent,
	label: string,
	prompt: string,
	model: string,
	schema: IntSchema,
): Promise<unknown> {
	console.log(`[${label}] started`);
	const run = await subagents.start(SPAWN, {
		label,
		prompt: [{ type: "text", text: prompt }],
		parent,
		signal: new AbortController().signal,
		agentOptions: { provider: PROVIDER, model },
		outputSchema: schema,
	});
	let streaming = false;
	const stop = ctx.on("session/event", (session, event) => {
		if (session.id !== run.id) return;
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
	try {
		const result = await run.result;
		if (result.stopReason !== "completed" || result.structured === undefined) {
			throw new Error(`agent ${label} ${result.stopReason}`);
		}
		console.log(`[${label}] completed`);
		return result.structured;
	} finally {
		stop();
		await run.dispose();
	}
}

/** Ask the primary agent to confirm the written file and summarize the run. */
async function summarize(
	agent: Agent,
	sessions: SessionStore,
	summary: {
		number: number;
		odd: boolean;
		branch: string;
		file: string;
		value: number;
	},
): Promise<string> {
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
	return (
		agent.session.events
			.filter((e) => e.type === "assistant/message")
			.at(-1)
			?.data.message.content.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("") ?? ""
	);
}

async function run(ctx: Context): Promise<number> {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const subagents = ctx.get("subagents");
	if (!agents || !sessions || !subagents) {
		console.error("dsh-demo: missing services (agents/sessions/subagents)");
		return 1;
	}

	const cwd = process.cwd();
	const { agent, dispose } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd },
		agentOptions: { provider: PROVIDER, model: PRIMARY },
	});
	try {
		await agent.whenIdle();
		const { number } = (await child(
			ctx,
			subagents,
			agent,
			"A",
			PROMPT_A,
			MODEL_A,
			int("number"),
		)) as { number: number };

		const odd = number % 2 !== 0;
		const branch = odd ? "B" : "C";
		const factor = odd ? 9 : 10;
		const file = odd ? "b.txt" : "c.txt";
		console.log(
			`[dsh-demo] random number = ${number} (${odd ? "odd" : "even"}) -> agent ${branch}`,
		);

		const { value } = (await child(
			ctx,
			subagents,
			agent,
			branch,
			promptBC(number, factor, file, cwd),
			odd ? MODEL_B : MODEL_C,
			int("value"),
		)) as { value: number };

		console.log(
			`[dsh-demo] agent ${branch} computed ${number} * ${factor} = ${value} -> ${file}`,
		);

		const text = await summarize(agent, sessions, {
			number,
			odd,
			branch,
			file,
			value,
		});
		if (text !== "") console.log(`[dsh-demo] primary agent: ${text}`);
		return 0;
	} finally {
		await dispose();
	}
}

let ctx: Context | undefined;
let code = 1;
try {
	ctx = await bootHarness();
	code = await run(ctx);
} catch (error) {
	console.error(`dsh-demo: ${error instanceof Error ? error.message : error}`);
} finally {
	if (ctx !== undefined) await shutdown(ctx, code);
}
process.exit(code);
