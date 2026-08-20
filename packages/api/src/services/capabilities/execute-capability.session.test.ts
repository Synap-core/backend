/**
 * Seam test — `executeCapability` stamps `proposals.session_id`.
 *
 * The `capability.run` propose branch built its proposal with `createPendingProposal`
 * but never passed `sessionId`, so the COLUMN migration 0119 added (soft FK +
 * index, added expressly to replace fragile correlationId text-matching) was
 * written NULL on every agent capability run. On the live pod: 45/45 pending
 * `capability/run` proposals had session_id NULL.
 *
 * This drives the real propose branch with the DB read + gate stubbed, and
 * asserts on the object handed to `createPendingProposal` — i.e. the row that
 * gets inserted, not a source-text pattern.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "5f3a1c88-1111-4bbb-8ccc-222222222222";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const proposals: any[] = [];

const SKILL_ROW = {
  id: "skill-1",
  name: "gmail_send",
  approved: false,
  userId: "user-1",
  kind: "code",
  providerSpec: null,
};

// PARTIAL mock (importOriginal) — a whole-module factory would null every
// sibling export this graph relies on. Only `db.select(...)` is replaced, with
// the exact chain the skill lookup walks.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [SKILL_ROW] }),
          }),
        }),
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "propose",
    proposalType: "capability.run",
    data: {},
  }),
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

// PARTIAL — `resolveActingChannelId` (same module) runs for real on the
// null-input path; a total factory would kill it and every other sibling.
vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createPendingProposal: async (input: any) => {
      proposals.push(input);
      return { id: `prop-${proposals.length}` };
    },
  };
});

const { executeCapability } = await import("./execute-capability.js");

const BASE = {
  verbId: "gmail_send",
  parameters: { to: "a@b.c" },
  workspaceId: WS,
  userId: "user-1",
  agentUserId: "agent-1",
};

describe("executeCapability — session provenance on capability.run", () => {
  beforeEach(() => {
    proposals.length = 0;
  });

  it("stamps the caller's sessionId onto the proposal row", async () => {
    const out = await executeCapability({ ...BASE, sessionId: SESSION });
    expect(out.kind).toBe("proposed");
    expect(proposals).toHaveLength(1);
    // The COLUMN, not a `data` field — that is what the index keys on.
    expect(proposals[0].sessionId).toBe(SESSION);
    expect(proposals[0].data.sessionId).toBeUndefined();
  });

  it("writes null when the caller has no session (correct for non-session activity)", async () => {
    const out = await executeCapability(BASE);
    expect(out.kind).toBe("proposed");
    expect(proposals[0].sessionId).toBeNull();
  });

  it("leaves the rest of the proposal untouched", async () => {
    await executeCapability({ ...BASE, sessionId: SESSION });
    expect(proposals[0]).toMatchObject({
      userId: "user-1",
      workspaceId: WS,
      agentUserId: "agent-1",
      targetType: "capability",
      targetId: "skill-1",
      proposalType: "capability.run",
    });
    expect(proposals[0].data).toMatchObject({
      skillId: "skill-1",
      verbId: "gmail_send",
      parameters: { to: "a@b.c" },
    });
  });
});
