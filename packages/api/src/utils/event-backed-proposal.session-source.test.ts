/**
 * THE SEAM the capture parity test cannot see: `createEventBackedProposal`
 * must FORWARD `sessionSource` to `createPendingProposal` (A1). The parity test
 * stubs `createEventBackedProposal` itself, so deleting this forward left it
 * green — measured by negative control (2026-09-14).
 *
 * Driven through the REAL `createEventBackedProposal`, mocked only at its two
 * outbound seams (the audit stamp and the pending door). No `agentUserId`, so
 * the dedup peek never runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pendingCalls: Array<Record<string, unknown>> = [];

vi.mock("./audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));
vi.mock("./permission-check.js", () => ({
  createPendingProposal: vi.fn(async (input: Record<string, unknown>) => {
    pendingCalls.push(input);
    return { id: "prop-1" };
  }),
}));

const { createEventBackedProposal } =
  await import("./event-backed-proposal.js");

const BASE = {
  userId: "user-1",
  workspaceId: null,
  targetType: "entity",
  targetId: "t1",
  proposalType: "import.graph",
  data: { operations: [] },
  sessionId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

describe("createEventBackedProposal — forwards sessionSource to the pending door", () => {
  beforeEach(() => {
    pendingCalls.length = 0;
  });

  it("a DERIVED session reaches createPendingProposal as derived", async () => {
    await createEventBackedProposal({ ...BASE, sessionSource: "derived" });
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0].sessionId).toBe(BASE.sessionId);
    expect(pendingCalls[0].sessionSource).toBe("derived");
  });

  it("an EXPLICIT session reaches it as explicit", async () => {
    await createEventBackedProposal({ ...BASE, sessionSource: "explicit" });
    expect(pendingCalls[0].sessionSource).toBe("explicit");
  });
});
