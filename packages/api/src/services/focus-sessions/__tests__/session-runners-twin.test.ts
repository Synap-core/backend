import { describe, it, expect } from "vitest";
import { markTwins, type SessionRunner } from "../session-runners.js";

const run = (over: Partial<SessionRunner>): SessionRunner => ({
  harness: "claude-code",
  conversationId: "C-1",
  cwd: null,
  agentUserId: null,
  machineUserId: null,
  processId: "",
  processHost: null,
  processStartedAt: null,
  twin: [],
  firstSeenAt: "2026-10-28T10:00:00.000Z",
  lastSeenAt: "2026-10-28T10:00:00.000Z",
  live: true,
  conversation: null,
  ...over,
});

describe("markTwins", () => {
  const a = run({ processId: "a:1:1700000000000", processHost: "a" });
  const b = run({ processId: "b:2:1700000001000", processHost: "b" });

  it("two live processes of one conversation (id case folded) mark each other", () => {
    const [x, y] = markTwins([a, { ...b, conversationId: "c-1" }]);
    expect(x!.twin.map((t) => t.host)).toEqual(["b"]);
    expect(y!.twin.map((t) => t.host)).toEqual(["a"]);
  });

  it("the same process twice, a runner with no process, a stale copy and another conversation are not twins", () => {
    for (const other of [
      run({ processId: a.processId }),
      run({ processId: "" }),
      run({ processId: b.processId, live: false }),
      run({ processId: b.processId, conversationId: "other" }),
      run({ processId: b.processId, harness: "codex" }),
    ]) {
      expect(markTwins([a, other]).every((r) => r.twin.length === 0)).toBe(
        true
      );
    }
  });
});
