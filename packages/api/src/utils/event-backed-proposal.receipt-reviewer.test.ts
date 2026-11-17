/**
 * An agent's auto-applied receipt names NO reviewer; a person's own
 * first-party write names the person (`createAutoApprovedProposal`).
 *
 * Driven through the REAL `createAutoApprovedProposal`, mocked only at the
 * row insert and the audit stamp. The discriminating pair: the same call with
 * and without an agent. A person's own first-party write keeps the person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    callingKeyAttribution: () => ({}),
    db: {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: "receipt-1", ...values }] };
        },
      }),
    },
  };
});
vi.mock("./audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));

const { createAutoApprovedProposal } =
  await import("./event-backed-proposal.js");

const PERSON = "user-person";
const AGENT = "agent-scout";
const BASE = {
  userId: PERSON,
  workspaceId: null,
  targetType: "entity",
  targetId: "t1",
  proposalType: "capture.graph",
  action: "graph",
  data: { operations: [] },
};

describe("createAutoApprovedProposal: who reviewed a receipt", () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  it("an agent's receipt names no reviewer, keeps the agent and when it settled", async () => {
    await createAutoApprovedProposal({ ...BASE, agentUserId: AGENT });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      status: "auto_approved",
      reviewedBy: null,
      agentUserId: AGENT,
      subjectUserId: PERSON,
    });
    expect(inserted[0]!.reviewedAt).toBeInstanceOf(Date);
  });

  it("a write that says it is an agent's names no reviewer, even with no agent id", async () => {
    // The same predicate migration 0428 clears old rows by.
    await createAutoApprovedProposal({
      ...BASE,
      data: { operations: [], source: "agent" },
    });
    expect(inserted[0]).toMatchObject({ reviewedBy: null });
  });

  it("a person's own first-party write keeps the person as its reviewer", async () => {
    await createAutoApprovedProposal({ ...BASE });
    expect(inserted[0]).toMatchObject({ reviewedBy: PERSON });
    expect(inserted[0]).not.toHaveProperty("agentUserId");
  });
});
