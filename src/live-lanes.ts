/**
 * live-lanes.ts — process-scoped registry of the live lane-worker children
 * of an in-progress run, keyed by the resumed primary session.
 *
 * The run factory knows the worker child session ids it spawns
 * (ctx.subagents.start → run.id); the transcript loader needs them so the
 * "live lanes" of our own run render alongside the primary (spec #44, User
 * Story 8). The registry is the in-memory bridge between the two: the race
 * is an active run for a primary session, so the entry lives only as long as
 * the run and is dropped on teardown. Stored subagent history is never
 * involved — this is purely our own run's live children.
 *
 * Lifetime is module-scoped (one server process): register when a worker of
 * the resumed session spawns, unregister when the run ends (normal, error,
 * or cancel). Strictly an ephemeral read-side index — it never mutates any
 * session.
 */
/** One live lane-worker of an in-progress run, keyed by its child session. */
export interface LiveLaneRef {
	/** Which lane this worker is ("left" | "right"). */
	readonly laneId: string;
	/** The worker's spawned child session id (its own store log). */
	readonly workerSessionId: string;
}

/** Mount one primary session's live lanes; returns the disposer. */
export function registerLiveLanes(
	primarySessionId: string,
	lanes: readonly LiveLaneRef[],
): () => void {
	const current = liveLaneRegistry.get(primarySessionId);
	const merged = [...(current ?? []), ...lanes];
	liveLaneRegistry.set(primarySessionId, merged);
	return () => {
		const now = liveLaneRegistry.get(primarySessionId);
		if (now === undefined) return;
		const next = now.filter((ref) => !lanes.includes(ref));
		if (next.length === 0) liveLaneRegistry.delete(primarySessionId);
		else liveLaneRegistry.set(primarySessionId, next);
	};
}

/** The live lane refs of one in-progress run's primary session, or empty. */
export function liveLanesFor(
	primarySessionId: string,
): readonly LiveLaneRef[] {
	return liveLaneRegistry.get(primarySessionId) ?? [];
}

/** Process-scoped live-run index: resumed primary session → its lane children. */
const liveLaneRegistry = new Map<string, readonly LiveLaneRef[]>();
