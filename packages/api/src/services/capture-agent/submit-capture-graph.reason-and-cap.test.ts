/**
 * An agent's graph that waits says WHY, and meets the same pending budget as
 * its single writes (structural plan S4).
 *
 * THE GAPS:
 *  - `captureGraphMemberProposes` answered a boolean, so the pending row kept
 *    no reason: proposal 96aefeaf read `governanceReason: null` and why it
 *    waited could not be known. The single-entity gate stores `gov.reasonCode`
 *    in that column; the graph lane now stores its first proposing member's.
 *  - the pending-proposal cap (F2) lived only in `createProposal`, so the graph
 *    lane filed past it while its rows spent the other doors' budget.
 *
 * Driven through the REAL `submitCaptureGraph` and the REAL
 * `captureGraphMemberVerdict`; the resolver's verdict and the budget helper are
 * scripted at their seams, and the pending writer is observed.
 *
 * Rows that rule out a wrong rule:
 *  - a member proposing with a code ⇒ that code is stored (not a constant);
 *  - a possible twin still wins as POSSIBLE_DUPLICATE (the duplicate door is
 *    why, not the member);
 *  - over the cap ⇒ refused, nothing filed; under it ⇒ filed;
 *  - a non-agent caller (webhook, cron) is never budgeted.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveGraphWorkspaceFromSlugs,
  resolveIdentity,
} from "@synap/database";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";

const h = vi.hoisted(() => ({
  refusal: null as null | { denied: true; reason: string },
  capCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveGraphWorkspaceFromSlugs: vi.fn(),
    resolveIdentity: vi.fn(),
    db: {
      ...actual.db,
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
  };
});
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-identity-service.js")>()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi.fn(),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  refuseAtAgentPendingCap: async (args: Record<string, unknown>) => {
    h.capCalls.push(args);
    return h.refusal;
  },
}));
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));
vi.mock(
  "../duplicates/find-duplicate-candidates.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../duplicates/find-duplicate-candidates.js")
      >();
    return {
      ...actual,
      loadOwnPendingCreates: vi.fn(async () => ({
        creates: [],
        truncated: false,
      })),
    };
  }
);

const { submitCaptureGraph } = await import("./submit-capture-graph.js");
const writer = await import("../../utils/event-backed-proposal.js");
const dedup = await import("../../utils/pending-capture-dedup.js");

const JANE = { id: "ent-jane", title: "Jane Doe", type: "person" };

beforeEach(() => {
  vi.restoreAllMocks();
  h.refusal = null;
  h.capCalls.length = 0;
  vi.mocked(resolveGraphWorkspaceFromSlugs).mockResolvedValue({
    workspaceId: null,
    rung: 6,
    reason: "pod-wide",
    confidence: 1,
    candidates: [],
    ask: false,
  });
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(null as never);
  vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
  vi.mocked(resolveIdentity).mockResolvedValue({
    match: null,
    candidates: [],
    crossKindCandidates: [],
  } as never);
  // Every member proposes, for a NAMED reason.
  vi.mocked(resolveAgentGovernanceDecision).mockResolvedValue({
    decision: "propose",
    reason: "Over today's limit.",
    reasonCode: "DAILY_WRITE_CEILING",
  } as never);
});

async function capture(agentUserId: string | undefined = "agent-1") {
  const pending = vi
    .spyOn(writer, "createEventBackedProposal")
    .mockImplementation(async (input) => ({
      proposal: { id: "prop-1", data: input.data } as never,
      requestedEvent: null,
      correlationId: "c",
    }));
  const result = submitCaptureGraph({
    userId: "user-1",
    ...(agentUserId ? { agentUserId } : {}),
    workspaceId: null,
    entities: [
      { ref: "p1", profileSlug: "person", title: "Jane Doe", properties: {} },
    ] as never,
  } as never);
  return { result, pending };
}

describe("a waiting agent graph stores why it waits", () => {
  it("the first proposing member's reason code lands in governanceReason", async () => {
    const { result, pending } = await capture();
    await expect(result).resolves.toMatchObject({ applied: false });
    expect(pending).toHaveBeenCalledTimes(1);
    expect(pending.mock.calls[0]![0].governanceReason).toBe(
      "DAILY_WRITE_CEILING"
    );
  });

  it("a different member reason is stored as itself — not a constant", async () => {
    vi.mocked(resolveAgentGovernanceDecision).mockResolvedValue({
      decision: "propose",
      reasonCode: "USER_OBSERVATION_INFERENCE",
    } as never);
    const { result, pending } = await capture();
    await result;
    expect(pending.mock.calls[0]![0].governanceReason).toBe(
      "USER_OBSERVATION_INFERENCE"
    );
  });

  it("a possible twin is still filed as POSSIBLE_DUPLICATE (the duplicate door is why)", async () => {
    vi.mocked(resolveIdentity).mockResolvedValue({
      match: "weak",
      entity: JANE,
      candidates: [JANE],
      crossKindCandidates: [],
    } as never);
    const { result, pending } = await capture();
    await result;
    expect(pending.mock.calls[0]![0].governanceReason).toBe(
      "POSSIBLE_DUPLICATE"
    );
  });
});

describe("an agent graph meets the same pending budget as its single writes", () => {
  it("over the cap: refused with the budget's own sentence, and nothing is filed", async () => {
    h.refusal = {
      denied: true,
      reason:
        "Agent proposal limit reached (120 pending). Nothing was written.",
    };
    const { result, pending } = await capture();
    await expect(result).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Agent proposal limit reached"),
    });
    expect(pending).not.toHaveBeenCalled();
    expect(h.capCalls).toEqual([
      expect.objectContaining({
        attributionAgentUserId: "agent-1",
        userId: "user-1",
        subjectType: "entity",
        action: "create",
      }),
    ]);
  });

  it("under the cap: filed", async () => {
    const { result, pending } = await capture();
    await expect(result).resolves.toMatchObject({ applied: false });
    expect(h.capCalls).toHaveLength(1);
    expect(pending).toHaveBeenCalledTimes(1);
  });

  it("a non-agent caller (webhook, cron) is never budgeted", async () => {
    h.refusal = { denied: true, reason: "would refuse" };
    const { result, pending } = await capture(undefined);
    await expect(result).resolves.toMatchObject({ applied: false });
    expect(h.capCalls).toEqual([]);
    expect(pending).toHaveBeenCalledTimes(1);
  });
});
