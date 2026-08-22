/**
 * @dsh-demo/driver — DeepSeek Harness as a script.
 *
 * Mounted as a one-shot plugin on the `dsh-demo` profile (dsh-base only), this
 * driver:
 *   1. creates the PRIMARY agent (`~deepseek/deepseek-v4-flash-latest`),
 *   2. starts a pre-authored workflow whose script spawns agent A
 *      (`openai/gpt-5.6-luna`) to generate a random integer,
 *   3. branches deterministically on parity:
 *        odd  -> agent B (`~deepseek/deepseek-v4-flash-latest`) computes n*9  → b.txt
 *        even -> agent C (`openai/gpt-5.6-luna`)               computes n*10 → c.txt
 *   4. hands the result back to the PRIMARY agent, which reports it,
 *   5. flushes the session and exits 0/1.
 *
 * Every child is a subagent of the primary (parent lineage), so "primary agent
 * starts agent A" holds in the DSH sense: A/B/C are the primary's subagents,
 * each on its own configured OpenRouter model. The branching itself is
 * deterministic script logic, not an LLM decision — that is the point of
 * driving DSH from a script.
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-cmdline";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-workflow";

/** Stable Cordis plugin name. */
export const name = "dsh-demo-driver";

/** Core services required before the one-shot run can start. */
export const inject = ["agents", "sessions"];

/**
 * Plugin config (all optional). No `Config` schema is declared, so Cordis
 * passes the raw object through unvalidated.
 */
export interface Config {
	/** Directory b.txt/c.txt are written into (default: process.cwd()). */
	outputDir?: string;
}

const PROVIDER = "openrouter";
const MODEL_PRIMARY = "~deepseek/deepseek-v4-flash-latest";
const MODEL_A = "openai/gpt-5.6-luna";
const MODEL_B = "~deepseek/deepseek-v4-flash-latest";
const MODEL_C = "openai/gpt-5.6-luna";

/**
 * The workflow script body (plain JS, top-level await allowed). It runs in a
 * worker-thread vm; `agent()` spawns a subagent of the run's parent (the
 * primary agent) with per-call provider/model, and `args` carries the cwd.
 */
const SCRIPT = `
// --- agent A: generate the random number (openai/gpt-5.6-luna) ---
const a = await agent(
  'Generate a truly random integer between 1 and 100 by running the bash tool with this exact command: node -e "console.log(Math.floor(Math.random()*100)+1)". Read the printed number from the tool result, then report it by calling the structured_output tool with {"number": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.',
  {
    label: 'A-generate-number',
    provider: '${PROVIDER}',
    model: '${MODEL_A}',
    schema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'], additionalProperties: false },
  },
)
if (a === null) throw new Error('agent A failed to produce a random number')
const number = a.number

// --- deterministic branch on parity ---
const odd = number % 2 !== 0
const branch = odd ? 'B' : 'C'
const factor = odd ? 9 : 10
const file = odd ? 'b.txt' : 'c.txt'
const model = odd ? '${MODEL_B}' : '${MODEL_C}'

// --- agent B/C: compute and write the file ---
const r = await agent(
  'The random number is ' + number + '. Compute ' + number + ' * ' + factor + ' = ? and write the result to ' + file + ' at the absolute path ' + args.cwd + '/' + file + ' using the write tool. Then report your computed value by calling the structured_output tool with {"value": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.',
  {
    label: branch + '-compute-write',
    provider: '${PROVIDER}',
    model,
    schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
  },
)
if (r === null) throw new Error('agent ' + branch + ' failed')

return { number, odd, branch, file, value: r.value }
`;

/** Aggregate the last assistant text from a session's events. */
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

/** Drive the whole demo and return the process exit code. */
async function run(ctx: Context, config: Config): Promise<number> {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const engine = ctx.get("workflowEngine");
	if (agents === undefined || sessions === undefined || engine === undefined) {
		console.error(
			"dsh-demo-driver: missing services (agents/sessions/workflowEngine)",
		);
		return 1;
	}

	const cwd = config.outputDir ?? process.cwd();

	// PRIMARY agent (~deepseek/deepseek-v4-flash-latest); every workflow child is its subagent.
	const { agent, dispose } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd },
		agentOptions: { provider: PROVIDER, model: MODEL_PRIMARY },
	});
	try {
		await agent.whenIdle();

		const run = engine.start({
			script: SCRIPT,
			meta: {
				name: "random-number-demo",
				description: "primary -> A(random) -> B/C(compute+write)",
			},
			args: { cwd },
			parent: agent,
		});
		const result = await run.result;
		try {
			if (result.stopReason !== "completed") {
				console.error(
					`dsh-demo-driver: workflow ${result.stopReason}: ${result.error ?? ""}`,
				);
				return 1;
			}
			const value = result.value as {
				number: number;
				odd: boolean;
				branch: string;
				file: string;
				value: number;
			};
			console.log(
				`[dsh-demo] random number = ${value.number} (${value.odd ? "odd" : "even"})`,
			);
			console.log(
				`[dsh-demo] agent ${value.branch} computed ${value.number} * ${value.odd ? 9 : 10} = ${value.value} -> ${value.file}`,
			);

			// PRIMARY agent receives the result and reports it ("primary agent gets the result").
			try {
				agent.followup(
					createUserMessage({
						content: [
							{
								type: "text",
								text: `The workflow finished. Random number: ${value.number} (${value.odd ? "odd" : "even"}). Agent ${value.branch} computed ${value.value} and wrote it to ${value.file}. Confirm the file was written and summarize the run in one short message.`,
							},
						],
						source: { kind: "user" },
					}),
				);
				await agent.whenIdle();
				await sessions.flush(agent.session);
				const summary = lastAssistantText(agent.session.events);
				if (summary !== "") console.log(`[dsh-demo] primary agent: ${summary}`);
			} catch (error) {
				console.warn(
					`dsh-demo-driver: primary summary turn failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return 0;
		} finally {
			// Terminate the workflow worker thread so the process can exit.
			await run.dispose();
		}
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
	void run(ctx, config ?? {}).then(
		(code) => exit(code),
		(error) => {
			console.error(
				`dsh-demo-driver: ${error instanceof Error ? error.message : String(error)}`,
			);
			exit(1);
		},
	);
}
