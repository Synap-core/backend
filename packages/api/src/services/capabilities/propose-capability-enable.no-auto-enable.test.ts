/**
 * An enable request can NEVER become an enabled pack at filing time — even for
 * an agent whose governance would auto-approve its writes (a widening
 * `governance_rules` row, an `autoApproveFor` lane).
 *
 * The ladder is simulated at its door: `checkPermissionOrPropose` answers
 * `granted` for anything. The filing must still go through
 * `createPendingProposal` (which inserts PENDING unconditionally —
 * `insertPendingProposal`), never consult the ladder, and never write to
 * `skills` (the only way a pack becomes enabled is `skills.approved = true`).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const PACK = { id: "cap-research", name: "Research Methods" };
const pending: any[] = [];
const ladder = vi.fn(async () => ({ granted: true }));
const dbWrites: unknown[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "skill-a", name: "source-triage" }],
        }),
      }),
      update: (table: unknown) => {
        dbWrites.push(table);
        return { set: () => ({ where: async () => undefined }) };
      },
      insert: (table: unknown) => {
        dbWrites.push(table);
        return { values: () => ({ returning: async () => [] }) };
      },
    },
  };
});

vi.mock("./capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async (m: { skillIds: string[] }) =>
    new Map(m.skillIds.map((id) => [`skill:${id}`, PACK])),
}));

vi.mock("../links/links-service.js", () => ({
  getCapabilityMemberParts: async () => [
    { kind: "skill", id: "skill-a", capabilityId: PACK.id },
  ],
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The widest posture: every ladder verdict is "granted".
    checkPermissionOrPropose: ladder,
    previewPermissionDecision: async () => ({ decision: "execute" }),
    createPendingProposal: async (input: any) => {
      pending.push(input);
      return { id: `prop-${pending.length}`, status: "pending" };
    },
  };
});

const { proposeCapabilityEnable } =
  await import("./propose-capability-enable.js");

describe("proposeCapabilityEnable — never an auto-enable", () => {
  beforeEach(() => {
    pending.length = 0;
    dbWrites.length = 0;
    ladder.mockClear();
  });

  it("an agent whose governance would auto-approve still gets a PENDING request, and no skill is enabled", async () => {
    const offers = await proposeCapabilityEnable({
      refused: [{ id: "skill-a", name: "source-triage" }],
      userId: "owner-1",
      workspaceId: "ws-1",
      agentUserId: "trusted-agent",
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      status: "proposed",
      originalActionRan: false,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].proposalType).toBe("capability.enable");
    expect(ladder).not.toHaveBeenCalled();
    expect(dbWrites).toEqual([]);
  });
});
