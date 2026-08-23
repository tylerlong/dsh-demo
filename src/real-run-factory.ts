/**
 * real-run-factory.ts — the harness-backed run factory (ticket #5).
 *
 * Production's {@link StartRun}: given the booted harness context, a run
 * request, and the run's event sink, it
 *
 *   1. resolves the harness provider route for every requested model id from
 *      the same configured model list the dropdowns use (model-list.ts),
 *   2. creates the **orchestrator** (the primary agent) on the requested
 *      primary model,
 *   3. spawns the two **workers** concurrently — one per lane, each on its
 *      lane's model — restricted to the read-only tool filter (read,
 *      read_image, glob, grep) so concurrent lanes never conflict over edits
 *      (ADR-0001),
 *   4. routes real session events to the owning lane (text deltas) and the
 *      top section (spawn notice, final comparison summary), and
 *   5. supports real cancellation: one Cancel aborts the shared
 *      AbortController, stops the orchestrator and both workers, and emits
 *      run/canceled.
 *
 * This is the seam's production wiring: src/server.ts + the browser UI build
 * on the RunEvent vocabulary from run-factory.ts and work unchanged. The
 * scripted factory in run-factory.ts stays for the seam tests.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { type ContentBlock, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
	finalAssistantOutput,
	type SubagentResult,
	type SubagentRun,
} from "@deepseek-ai/dsh-subagent";
import { convertLlmModels, type LlmLike } from "./model-list.ts";
import type { LaneId, RunEvent, RunRequest, StartRun } from "./run-factory.ts";

/** The subagent provider that spawns in-process children (see the demos). */
const SPAWN_PROVIDER = "spawn";

/**
 * The read-only tools every lane worker may use. Workers never write, so two
 * lanes sharing one workspace can run concurrently without conflicting over
 * edits (ADR-0001, parent ticket #1).
 */
export const WORKER_TOOLS = ["read", "read_image", "glob", "grep"] as const;

/** Render any thrown value as a message string. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Join the text blocks of an assistant output into one string. */
function textOf(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** A lane worker's settled outcome, fed into the orchestrator's summary. */
interface LaneOutcome {
	readonly lane: LaneId;
	readonly model: string;
	/** The worker's final answer text, or an error note when it failed. */
	readonly text: string;
}

/** One lane worker's prompt: the task, performed read-only, free-form answer. */
function workerPrompt(task: string): string {
	return [
		"You are a read-only worker in a two-model comparison run.",
		"Perform the task below using only your read-only tools (read, read_image, glob, grep).",
		"You cannot write or edit files.",
		"When you are finished, reply with your answer as free-form text.",
		"",
		`TASK: ${task}`,
	].join("\n");
}

/** The orchestrator's summary prompt: both answers, ask for a comparison. */
function summaryPrompt(
	request: RunRequest,
	left: LaneOutcome | undefined,
	right: LaneOutcome | undefined,
): string {
	const lane = (outcome: LaneOutcome | undefined, label: string): string =>
		outcome === undefined
			? `${label}: (no result)`
			: `${label} (${outcome.model}):\n${outcome.text}`;
	return [
		`The two workers finished the task: "${request.task}".`,
		"",
		lane(left, "Left lane"),
		"",
		lane(right, "Right lane"),
		"",
		"Write a short comparison summary: how did the two answers differ, and which model handled the task better and why?",
		"Reply with your summary as free-form text.",
	].join("\n");
}

/** A worker failure reason for the server console: the stop reason. */
function workerFailureReason(result: SubagentResult): string {
	return result.stopReason;
}

/**
 * Resolve the harness provider route for every requested model id from the
 * configured model list (the same source the dropdowns populate from). One
 * pass over every live provider's models; the first provider listing a model
 * id owns it.
 */
async function resolveProviders(ctx: Context): Promise<Map<string, string>> {
	const providers = new Map<string, string>();
	const models = await convertLlmModels(ctx.llm as unknown as LlmLike);
	for (const model of models) {
		if (!providers.has(model.id)) providers.set(model.id, model.provider);
	}
	return providers;
}

/**
 * Watch one session's live event feed and forward text deltas to a sink.
 * Returns the listener disposer.
 */
function watchSession(
	ctx: Context,
	sessionId: SessionId,
	onText: (text: string) => void,
): () => void {
	return ctx.on("session/event", (session, event) => {
		if (session.id !== sessionId) return;
		if (
			event.type === "assistant/chunk" &&
			event.data.chunk.type === "text-delta"
		) {
			onText(event.data.chunk.text);
		}
	});
}

/**
 * Build the production run factory against a booted harness context.
 *
 * Each {@link StartRun} call emits run/started synchronously (so the tab locks
 * its inputs immediately), then drives the whole comparison in the
 * background: orchestrator creation, concurrent read-only workers, the
 * orchestrator's comparison summary, and teardown. The returned handle's
 * cancel() aborts the shared controller, stops the orchestrator and both
 * workers, and emits run/canceled.
 */
export function createRunFactory(ctx: Context): StartRun {
	return (request, onEvent) => {
		const runId = randomUUID();
		const controller = new AbortController();
		let orchestratorHandle: AgentHandle | undefined;
		const workerRuns: SubagentRun[] = [];
		let terminal = false;
		let lanesStarted = false;

		/** Forward one event; nothing flows after the run reached a terminal state. */
		const emit = (event: RunEvent): void => {
			if (terminal) return;
			onEvent(event);
			if (event.type === "run/done" || event.type === "run/canceled") {
				terminal = true;
			}
		};

		/** Dispose every live worker run, then the orchestrator (children first). */
		const disposeAll = async (): Promise<void> => {
			const runs = workerRuns.splice(0);
			await Promise.all(runs.map((run) => run.dispose().catch(() => {})));
			const handle = orchestratorHandle;
			orchestratorHandle = undefined;
			if (handle !== undefined) {
				await handle.dispose().catch(() => {});
			}
		};

		/** Run one lane's read-only worker and settle its outcome. */
		const runWorker = async (
			lane: LaneId,
			model: string,
			provider: string,
			orchestrator: Agent,
		): Promise<LaneOutcome> => {
			emit({ type: "lane/worker/started", laneId: lane });
			try {
				const run = await ctx.subagents.start(SPAWN_PROVIDER, {
					label: `lane-${lane}`,
					prompt: [{ type: "text", text: workerPrompt(request.task) }],
					parent: orchestrator,
					signal: controller.signal,
					agentOptions: { provider, model },
					toolFilter: { allow: WORKER_TOOLS },
				});
				workerRuns.push(run);
				const stopWatching = watchSession(ctx, run.id, (text) => {
					if (!controller.signal.aborted) {
						emit({ type: "lane/worker/delta", laneId: lane, text });
					}
				});
				try {
					const result = await run.result;
					if (controller.signal.aborted) {
						return { lane, model, text: "" };
					}
					if (result.stopReason === "completed") {
						emit({ type: "lane/worker/done", laneId: lane });
						return { lane, model, text: textOf(result.output) };
					}
					const reason = workerFailureReason(result);
					emit({ type: "lane/worker/error", laneId: lane, reason });
					// The reason stays server-side (console only); the summary
					// prompt gets a neutral note so it never reaches the UI.
					return {
						lane,
						model,
						text: `(${lane} lane worker failed)`,
					};
				} finally {
					stopWatching();
					// Dispose exactly once: drop the run from the shared list
					// first, so disposeAll() (cancel / flow teardown) never
					// disposes an already-settled run again.
					const index = workerRuns.indexOf(run);
					if (index !== -1) workerRuns.splice(index, 1);
					await run.dispose().catch(() => {});
				}
			} catch (error) {
				if (controller.signal.aborted) {
					return { lane, model, text: "" };
				}
				const reason = messageOf(error);
				emit({ type: "lane/worker/error", laneId: lane, reason });
				// The reason stays server-side (console only); the summary
				// prompt gets a neutral note so it never reaches the UI.
				return {
					lane,
					model,
					text: `(${lane} lane worker failed)`,
				};
			}
		};

		/** The whole comparison: orchestrator, workers, summary, teardown. */
		const orchestrate = async (): Promise<void> => {
			const providers = await resolveProviders(ctx);
			const primaryProvider = providers.get(request.primaryModel);
			const leftProvider = providers.get(request.laneModels.left);
			const rightProvider = providers.get(request.laneModels.right);
			if (primaryProvider === undefined) {
				throw new Error(
					`no configured provider for primary model "${request.primaryModel}"`,
				);
			}
			if (leftProvider === undefined) {
				throw new Error(
					`no configured provider for left lane model "${request.laneModels.left}"`,
				);
			}
			if (rightProvider === undefined) {
				throw new Error(
					`no configured provider for right lane model "${request.laneModels.right}"`,
				);
			}

			// The orchestrator (primary agent) on the requested model.
			const handle = await ctx.agents.create({
				sessionId: SessionId(`session-${runId}`),
				meta: { cwd: process.cwd() },
				agentOptions: {
					provider: primaryProvider,
					model: request.primaryModel,
				},
				signal: controller.signal,
			});
			orchestratorHandle = handle;
			const orchestrator = handle.agent;

			emit({
				type: "orchestrator/delta",
				text: `Starting run: spawning two workers on ${request.laneModels.left} and ${request.laneModels.right}…\n`,
			});

			// Both workers run concurrently; each lane settles independently.
			lanesStarted = true;
			const [left, right] = await Promise.all([
				runWorker("left", request.laneModels.left, leftProvider, orchestrator),
				runWorker(
					"right",
					request.laneModels.right,
					rightProvider,
					orchestrator,
				),
			]);
			if (controller.signal.aborted) return;

			// The orchestrator compares both answers and produces the summary.
			const summary = await summarize(orchestrator, request, left, right);
			if (controller.signal.aborted) return;
			if (summary !== "") emit({ type: "run/summary", summary });
			emit({ type: "run/done", runId });
		};

		/** Ask the orchestrator for the comparison summary and read its answer. */
		const summarize = async (
			orchestrator: Agent,
			request: RunRequest,
			left: LaneOutcome,
			right: LaneOutcome,
		): Promise<string> => {
			orchestrator.followup(
				createUserMessage({
					content: [
						{
							type: "text",
							text: summaryPrompt(request, left, right),
						},
					],
					source: { kind: "user" },
				}),
			);
			await orchestrator.whenIdle();
			const output = finalAssistantOutput(orchestrator.session.events);
			return output === undefined ? "" : textOf(output);
		};

		// The run's background drive; failures become lane errors + run/done
		// (before the lanes start) or run/done alone (lanes already settled).
		const flow = (async () => {
			try {
				await orchestrate();
			} catch (error) {
				if (controller.signal.aborted) return;
				const reason = messageOf(error);
				if (!lanesStarted) {
					emit({ type: "lane/worker/error", laneId: "left", reason });
					emit({ type: "lane/worker/error", laneId: "right", reason });
				}
				emit({ type: "run/done", runId });
			} finally {
				await disposeAll();
			}
		})();
		void flow.catch((error) => {
			console.error(`dsh-compare: run ${runId} failed: ${messageOf(error)}`);
		});

		emit({ type: "run/started", runId });

		return {
			id: runId,
			cancel() {
				if (terminal) return;
				controller.abort();
				void (async () => {
					const handle = orchestratorHandle;
					if (handle !== undefined) {
						handle.agent.cancel({ kind: "user" });
					}
					await disposeAll();
					emit({ type: "run/canceled", runId });
				})();
			},
		};
	};
}
