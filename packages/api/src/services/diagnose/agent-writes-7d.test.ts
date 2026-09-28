import { describe, expect, it } from "vitest";
import { foldAgentStatusRows } from "./agent-scorecard.js";

/**
 * Settings › Agents shows "N writes · 7d" per agent (V1 W4). A write is a
 * proposal that APPLIED — approved or auto-approved, a partial apply included —
 * created in the window. Pending, rejected, reverted and withdrawn rows are
 * decisions, never writes; an old apply is a lifetime count, never a recent one.
 */
describe("foldAgentStatusRows — writes7d", () => {
  it("counts only recent applies, and keeps every lifetime bucket unchanged", () => {
    const byAgent = foldAgentStatusRows([
      {
        agentUserId: "a",
        status: "approved",
        isPartial: false,
        isRecent: true,
        count: 3,
      },
      {
        agentUserId: "a",
        status: "auto_approved",
        isPartial: false,
        isRecent: true,
        count: 4,
      },
      {
        agentUserId: "a",
        status: "auto_approved",
        isPartial: true,
        isRecent: true,
        count: 1,
      },
      {
        agentUserId: "a",
        status: "approved",
        isPartial: false,
        isRecent: false,
        count: 10,
      },
      {
        agentUserId: "a",
        status: "pending",
        isPartial: false,
        isRecent: true,
        count: 5,
      },
      {
        agentUserId: "a",
        status: "rejected",
        isPartial: false,
        isRecent: true,
        count: 2,
      },
      {
        agentUserId: "a",
        status: "reverted",
        isPartial: false,
        isRecent: true,
        count: 1,
      },
      {
        agentUserId: null,
        status: "approved",
        isPartial: false,
        isRecent: true,
        count: 9,
      },
    ]);
    const a = byAgent.get("a")!;
    expect(a.writes7d).toBe(8);
    expect(a.approved).toBe(17);
    expect(a.autoApproved).toBe(4);
    expect(a.partiallyApproved).toBe(1);
    expect(a.pending).toBe(5);
    expect(byAgent.size).toBe(1);
  });
});
