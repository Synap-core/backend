/**
 * Seam test — D3: an agent refused on an installed-but-not-enabled capability
 * files ONE enable request for the pack and is told the action did not run.
 *
 * Drives the real `executeCapability` deny branch and the real
 * `proposeCapabilityEnable` with the skill read, the gate, the container lens
 * and the proposal insert stubbed. The insert stub dedups with the REAL
 * `computeProposalDedupHash` (the same hash `insertPendingProposal` keys its
 * PENDING-row lookup on), so "the second call dedups" is asserted on the
 * hash the database would compute, not on a flag this test invents.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PACK = { id: "cap-research", name: "Research Methods" };

const SOURCE_TRIAGE = {
  id: "skill-a",
  name: "source-triage",
  approved: false,
  userId: "owner-1",
  kind: "instruction",
  providerSpec: null,
};
const EVIDENCE = {
  ...SOURCE_TRIAGE,
  id: "skill-b",
  name: "evidence-synthesis",
};

let skillRow: Record<string, unknown> = SOURCE_TRIAGE;
let gateDecision: Record<string, unknown> = {
  decision: "deny",
  reason: "This capability is installed but not yet enabled.",
};
const inserted: any[] = [];
const byHash = new Map<string, string>();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            // the executeCapability skill lookup
            orderBy: () => ({ limit: async () => [skillRow] }),
            // the pack's draft-member read (awaited directly)
            then: (resolve: (v: unknown) => unknown) =>
              resolve([
                { id: SOURCE_TRIAGE.id, name: SOURCE_TRIAGE.name },
                { id: EVIDENCE.id, name: EVIDENCE.name },
              ]),
          }),
        }),
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => gateDecision,
}));

vi.mock("./capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async (m: { skillIds: string[] }) =>
    new Map(m.skillIds.map((id) => [`skill:${id}`, PACK])),
}));

vi.mock("../links/links-service.js", () => ({
  getCapabilityMemberParts: async () => [
    { kind: "skill", id: SOURCE_TRIAGE.id, capabilityId: PACK.id },
    { kind: "skill", id: EVIDENCE.id, capabilityId: PACK.id },
  ],
}));

vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async () => undefined,
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { computeProposalDedupHash } =
    await vi.importActual<typeof import("@synap/database")>("@synap/database");
  return {
    ...actual,
    createPendingProposal: async (input: any) => {
      const hash = computeProposalDedupHash(input);
      const existing = byHash.get(hash);
      if (existing && input.agentUserId) return { id: existing };
      inserted.push(input);
      const id = `prop-${inserted.length}`;
      byHash.set(hash, id);
      return { id };
    },
  };
});

const { executeCapability } = await import("./execute-capability.js");

const AGENT = {
  parameters: {},
  workspaceId: WS,
  userId: "user-1",
  agentUserId: "agent-1",
};

describe("executeCapability — agent deny on a draft capability proposes enabling it", () => {
  beforeEach(() => {
    inserted.length = 0;
    byHash.clear();
    skillRow = SOURCE_TRIAGE;
    gateDecision = {
      decision: "deny",
      reason: "This capability is installed but not yet enabled.",
    };
  });

  it("files exactly one request for the pack, and says the action did not run", async () => {
    const out = await executeCapability({ ...AGENT, verbId: "source-triage" });
    expect(out.kind).toBe("deny");
    if (out.kind !== "deny") return;
    expect(out.enableProposal).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
      originalActionRan: false,
    });
    expect(out.enableProposal?.message).toMatch(/Nothing ran/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      targetType: "capability",
      targetId: PACK.id,
      proposalType: "capability.enable",
      agentUserId: "agent-1",
    });
    // The whole pack's draft verbs, not just the refused one.
    expect(inserted[0].data.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(inserted[0].notificationDescription).toBe(
      'Enable Capability "Research Methods"'
    );
  });

  it("a second refusal — on a DIFFERENT verb of the same pack — dedups onto the first", async () => {
    const first = await executeCapability({
      ...AGENT,
      verbId: "source-triage",
    });
    skillRow = EVIDENCE;
    const second = await executeCapability({
      ...AGENT,
      verbId: "evidence-synthesis",
    });
    expect(inserted).toHaveLength(1);
    const id = (o: typeof first) =>
      o.kind === "deny" && o.enableProposal?.status === "proposed"
        ? o.enableProposal.proposalId
        : null;
    expect(id(first)).toBe("prop-1");
    expect(id(second)).toBe("prop-1");
  });

  it("a HUMAN refusal files nothing and keeps the Settings pointer", async () => {
    const out = await executeCapability({
      verbId: "source-triage",
      parameters: {},
      workspaceId: WS,
      userId: "user-1",
    });
    expect(out.kind).toBe("deny");
    if (out.kind !== "deny") return;
    expect(out.enableProposal).toBeUndefined();
    expect(out.enable?.kind).toBe("enable");
    expect(inserted).toHaveLength(0);
  });

  it("an agent denied for a POLICY reason on an ENABLED skill files nothing", async () => {
    skillRow = { ...SOURCE_TRIAGE, approved: true };
    gateDecision = {
      decision: "deny",
      reason: "Agent capability check failed",
    };
    const out = await executeCapability({ ...AGENT, verbId: "source-triage" });
    expect(out.kind).toBe("deny");
    if (out.kind !== "deny") return;
    expect(out.enableProposal).toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it("an unattended run (suppressProposal) files nothing", async () => {
    const out = await executeCapability({
      ...AGENT,
      verbId: "source-triage",
      suppressProposal: true,
    });
    expect(out.kind === "deny" && out.enableProposal).toBeFalsy();
    expect(inserted).toHaveLength(0);
  });
});
