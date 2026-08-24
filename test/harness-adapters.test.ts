import { describe, expect, it } from "vitest";
import { liveLanesFor, registerLiveLanes } from "../src/live-lanes.ts";
import { loadTranscriptFromContext } from "../src/harness-adapters.ts";
import type { TranscriptEvent } from "../src/session-transcript.ts";

/** Build an event whose data shape matches what the seam's fold consumes:
 *  user/message reads text from data.content; assistant/message from
 *  data.message.content (the message is nested under .message). */
function msg(type: string, text: string): TranscriptEvent {
  if (type === "user/message") {
    return { type, data: { content: [{ type: "text", text }] } };
  }
  return { type, data: { message: { content: [{ type: "text", text }] } } };
}

/** A fake context exposing a fake session store under "sessionPersistence". */
function fakeContext(store: Record<string, readonly TranscriptEvent[]>) {
  return {
    get(name: string): unknown {
      if (name !== "sessionPersistence") throw new Error(`unexpected service ${name}`);
      return {
        inspect(id: string) {
          const events = store[id] ?? [];
          return { meta: { id }, events };
        },
      };
    },
  };
}

describe("loadTranscriptFromContext live lanes", () => {
  it("supplies the two live lane-worker windows alongside the primary when the run is active", async () => {
    const ctx = fakeContext({
      "primary": [msg("user/message", "q")],
      "worker-left": [msg("assistant/message", "left out")],
      "worker-right": [msg("assistant/message", "right out")],
    });
    const load = loadTranscriptFromContext(ctx as never);
    const unLeft = registerLiveLanes("primary", [{ laneId: "left", workerSessionId: "worker-left" }]);
    const unRight = registerLiveLanes("primary", [{ laneId: "right", workerSessionId: "worker-right" }]);
    try {
      const transcript = await load("primary");
      expect(transcript.primary.lines.find(l => l.role === "input")?.text).toBe("q");
      expect(transcript.lanes.map(l => l.sessionId).sort()).toEqual(["worker-left", "worker-right"]);
      expect(transcript.lanes.map(l => l.lines[0].text).sort()).toEqual(["left out", "right out"]);
    } finally {
      unLeft(); unRight();
    }
  });

  it("leaves lanes empty with no live run", async () => {
    const ctx = fakeContext({ "primary": [msg("user/message", "q")] });
    const load = loadTranscriptFromContext(ctx as never);
    const transcript = await load("primary");
    expect(transcript.lanes).toEqual([]);
  });
});
