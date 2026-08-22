/**
 * @dsh-demo/driver — DeepSeek Harness as a script.
 *
 * One-shot plugin on the `dsh-demo` profile (dsh-base only): the PRIMARY agent
 * (~deepseek/deepseek-v4-flash-latest) starts a workflow whose script spawns
 * agent A (openai/gpt-5.6-luna) to generate a random integer, branches on
 * parity, then spawns agent B (deepseek, n*9 -> b.txt) or agent C (gpt-5.6-luna,
 * n*10 -> c.txt). The primary reports the result; the driver exits 0/1.
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
import type { WorkflowEngine, WorkflowRun } from "@deepseek-ai/dsh-workflow";

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
export const inject = ["agents", "sessions"];

/** Plugin config; no schema declared, so Cordis passes it through unvalidated. */
export interface Config {
	/** Directory b.txt/c.txt are written into (default: process.cwd()). */
	outputDir?: string;
	/** Abort the workflow after this many milliseconds (no timeout by default). */
	timeoutMs?: number;
}

const PROVIDER = "openrouter";
const MODEL_PRIMARY = "~deepseek/deepseek-v4-flash-latest";
const MODEL_A = "openai/gpt-5.6-luna";
const MODEL_B = "~deepseek/deepseek-v4-flash-latest";
const MODEL_C = "openai/gpt-5.6-luna";

/** What the workflow script returns to the driver. */
interface WorkflowValue {
	number: number;
	odd: boolean;
	branch: string;
	file: string;
	value: number;
}

const META = {
	name: "random-number-demo",
	description: "primary -> A(random) -> B/C(compute+write)",
};

/**
 * The workflow script body (plain JS, top-level await allowed). It runs in a
 * worker-thread vm; `agent()` spawns a subagent of the run's parent (the
 * primary agent) with per-call provider/model, and `args` carries the cwd.
 */
const SCRIPT = `
// A structured-result schema for a single integer field.
const intSchema = (key) => ({ type: 'object', properties: { [key]: { type: 'integer' } }, required: [key], additionalProperties: false })

// --- agent A: generate the random number (openai/gpt-5.6-luna) ---
const a = await agent(
  'Generate a truly random integer between 1 and 100 by running the bash tool with this exact command: node -e "console.log(Math.floor(Math.random()*100)+1)". Read the printed number from the tool result, then report it by calling the structured_output tool with {"number": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.',
  { label: 'A', provider: '${PROVIDER}', model: '${MODEL_A}', schema: intSchema('number') },
)
if (a === null) throw new Error('agent A failed to produce a random number')
const number = a.number

// --- deterministic branch on parity ---
const odd = number % 2 !== 0
const branch = odd ? 'B' : 'C'
const factor = odd ? 9 : 10
const file = odd ? 'b.txt' : 'c.txt'
const model = odd ? '${MODEL_B}' : '${MODEL_C}'
log('random number = ' + number + ' (' + (odd ? 'odd' : 'even') + ') -> agent ' + branch)

// --- agent B/C: compute and write the file ---
const r = await agent(
  'The random number is ' + number + '. Compute ' + number + ' * ' + factor + ' = ? and write the result to ' + file + ' at the absolute path ' + args.cwd + '/' + file + ' using the write tool. Then report your computed value by calling the structured_output tool with {"value": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.',
  { label: branch, provider: '${PROVIDER}', model, schema: intSchema('value') },
)
if (r === null) throw new Error('agent ' + branch + ' failed')

return { number, odd, branch, file, value: r.value }
`;

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
	value: WorkflowValue,
): Promise<void> {
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
}

/**
 * Print realtime workflow progress: agent lifecycle, script log lines, and the
 * token-level stream of every child (session/event is the live firehose).
 * Every agent-bound line is prefixed with the agent's name. Returns a disposer.
 */
function watchWorkflow(ctx: Context, run: WorkflowRun): () => void {
	// Child session id -> agent label, filled by agent-start events.
	const labels = new Map<SessionId, string>();
	// Child session ids currently streaming tokens (label prefix already printed).
	const streaming = new Set<SessionId>();

	const disposers = [
		ctx.on("workflow/agent-start", (info, agent) => {
			if (info.id !== run.id) return;
			labels.set(agent.childId, agent.label);
			console.log(`[${agent.label}] started`);
		}),
		ctx.on("workflow/agent-end", (info, agent) => {
			if (info.id !== run.id) return;
			console.log(`[${agent.label}] ${agent.outcome}`);
		}),
		ctx.on("workflow/log", (info, message) => {
			if (info.id !== run.id) return;
			console.log(`[wf] script: ${message}`);
		}),
		ctx.on("session/event", (session, event) => {
			const label = labels.get(session.id);
			if (label === undefined) return;
			if (
				event.type === "assistant/chunk" &&
				event.data.chunk.type === "text-delta"
			) {
				// Prefix once per stream, then keep appending tokens to the same line.
				if (!streaming.has(session.id)) {
					process.stdout.write(`\n[${label}] `);
					streaming.add(session.id);
				}
				process.stdout.write(event.data.chunk.text);
			} else if (event.type === "tool/call") {
				process.stdout.write(`\n[${label}] → tool ${event.data.name}\n`);
			} else if (event.type === "turn/end") {
				process.stdout.write("\n");
				streaming.delete(session.id);
			}
		}),
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}

/** Run the workflow script and return its value, disposing the worker thread. */
async function runWorkflow(
	ctx: Context,
	engine: WorkflowEngine,
	parent: Agent,
	cwd: string,
	timeoutMs: number | undefined,
): Promise<WorkflowValue> {
	// An aborted signal cancels the run and its children — no blind wait.
	const signal =
		timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
	const run = engine.start({
		script: SCRIPT,
		meta: META,
		args: { cwd },
		parent,
		signal,
	});
	const stopWatching = watchWorkflow(ctx, run);
	try {
		const result = await run.result;
		if (result.stopReason === "cancelled") {
			throw new Error(
				`workflow cancelled (timeout ${timeoutMs}ms): ${result.error ?? ""}`,
			);
		}
		if (result.stopReason !== "completed") {
			throw new Error(`workflow ${result.stopReason}: ${result.error ?? ""}`);
		}
		return result.value as WorkflowValue;
	} finally {
		stopWatching();
		await run.dispose(); // terminate the worker thread so the process can exit
	}
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

		const value = await runWorkflow(ctx, engine, agent, cwd, config.timeoutMs);
		console.log(
			`[dsh-demo] random number = ${value.number} (${value.odd ? "odd" : "even"})`,
		);
		console.log(
			`[dsh-demo] agent ${value.branch} computed ${value.number} * ${value.odd ? 9 : 10} = ${value.value} -> ${value.file}`,
		);
		try {
			await summarize(agent, sessions, value);
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
