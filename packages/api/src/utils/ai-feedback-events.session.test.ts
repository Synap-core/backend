/**
 * Seam test — `emitAiDecision` forwards `sessionId` to the events COLUMN.
 *
 * The direct-capability-run provenance fix stamps the session on the run's
 * `ai_decision` event. That only works if this recorder passes it through to
 * `auditLog`, which owns the `events.session_id` write (0241). The
 * capability-side test mocks `emitAiDecision`, so this is the half that proves
 * the forward exists — without it the session would be accepted and dropped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: any[] = [];
vi.mock("./audit-log.js", () => ({
  auditLog: async (opts: any) => {
    calls.push(opts);
    return null;
  },
}));

const { emitAiDecision } = await import("./ai-feedback-events.js");

const SESSION = "5f3a1c88-9999-4bbb-8ccc-777777777777";

describe("emitAiDecision — session provenance", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("forwards the caller's sessionId to the events COLUMN (not a data field)", async () => {
    await emitAiDecision({
      action: "capability_run",
      userId: "u1",
      correlationId: "c1",
      sessionId: SESSION,
      data: { kind: "capability_run" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(SESSION);
    expect(calls[0].data.sessionId).toBeUndefined();
  });

  it("writes null when there is no session — never synthesises one", async () => {
    await emitAiDecision({
      action: "capability_run",
      userId: "u1",
      correlationId: "c1",
      data: { kind: "capability_run" },
    });
    expect(calls[0].sessionId).toBeNull();
  });
});
