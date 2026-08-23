/**
 * Lane.tsx — one lane of the comparison (ticket #33).
 *
 * Renders one side of the run: a heading naming the lane, its worker's
 * status chip (idle / running · Ns / done · Ns / error · Ns / canceled · Ns),
 * and the worker's streamed output panel. The run lifecycle hook (useRun)
 * owns the lane state; this component only renders it, so the same component
 * renders both lanes side by side. The lane id (left / right) prefixes the
 * test ids so the e2e and the component tests address each lane's status and
 * output independently.
 */
import type { LaneId } from "../../shared/protocol.ts";
import type { LaneStatus } from "./useRun.ts";

export interface LaneProps {
	/** Which lane this is ("left" or "right"); also the test id prefix. */
	readonly laneId: LaneId;
	/** The lane's heading, e.g. "Left lane". */
	readonly heading: string;
	/** The worker's lifecycle status, shown as a chip. */
	readonly status: LaneStatus;
	/** The worker's streamed output text. */
	readonly output: string;
	/** Seconds the worker has been running (frozen at its terminal state). */
	readonly elapsed: number;
}

/** The chip text for a lane status; idle shows no chip at all. */
export function laneChipText(status: LaneStatus, elapsed: number): string {
	if (status === "idle") {
		return "";
	}
	return `${status} · ${elapsed}s`;
}

/** The chip color per status (Tailwind utilities). */
const CHIP_CLASSES: Record<LaneStatus, string> = {
	idle: "",
	running: "bg-blue-100 text-blue-800",
	done: "bg-green-100 text-green-800",
	error: "bg-red-100 text-red-800",
	canceled: "bg-gray-200 text-gray-700",
};

export function Lane({ laneId, heading, status, output, elapsed }: LaneProps) {
	const chip = laneChipText(status, elapsed);
	return (
		<section
			aria-label={heading}
			data-testid={`lane-${laneId}`}
			className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4"
		>
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold">{heading}</h2>
				<span
					data-testid={`lane-${laneId}-status`}
					className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_CLASSES[status]}`}
				>
					{chip}
				</span>
			</div>
			<pre
				data-testid={`lane-${laneId}-output`}
				className="min-h-[96px] whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-xs"
			>
				{output}
			</pre>
		</section>
	);
}
