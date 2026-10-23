import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveGraphWorkspaceFromSlugs,
  resolveIdentity,
} from "@synap/database";

/**
 * The capture door answers through the ONE duplicate door (FB1020 B2).
 *
 * Driven through the REAL `submitCaptureGraph` and the REAL
 * `findDuplicateCandidates`; only the identity resolver's verdict is scripted
 * (`resolveIdentity`), plus the two terminal writers it is observed through.
 *
 * Rows that rule out a wrong rule:
 *  - a same-kind NAME match (weak) is never linked — the deleted weak
 *    auto-link merged two different things silently — and an agent's graph
 *    with it is FILED (pending, POSSIBLE_DUPLICATE), never auto-applied;
 *  - no match → the agent's graph still auto-applies (rules out "every agent
 *    capture is a proposal");
 *  - a STRONG identity match still links and auto-applies (the one automatic
 *    outcome is untouched) — on PGlite in
 *    `submit-capture-graph.dedup-scope.pglite.test.ts`, since the link now
 *    reads the record's visibility (FB1020 review M3).
 */

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
  resolveAgentGovernanceDecision: vi
    .fn()
    .mockResolvedValue({ decision: "execute" }),
}));
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));
// The pending queue read is the door's own leg; no live db here. A failed
// read must not hide the record leg's answer.
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
const materializer = await import("../../utils/materialize-composite.js");
const dedup = await import("../../utils/pending-capture-dedup.js");

const JANE = { id: "ent-jane", title: "Jane Doe", type: "person" };

beforeEach(() => {
  vi.restoreAllMocks();
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
});

async function capture() {
  const pending = vi
    .spyOn(writer, "createEventBackedProposal")
    .mockImplementation(async (input) => ({
      proposal: { id: "prop-1", data: input.data } as never,
      requestedEvent: null,
      correlationId: "c",
    }));
  const receipt = vi
    .spyOn(writer, "createAutoApprovedProposal")
    .mockImplementation(
      async (input) =>
        ({
          proposal: { id: input.id, data: input.data } as never,
          requestedEvent: null,
          completedEvent: null,
          correlationId: "c",
        }) as never
    );
  const materialize = vi
    .spyOn(materializer, "materializeCompositeGraph")
    .mockResolvedValue({
      entities: [{ ref: "p1", entityId: "ent-new", linked: false }],
      relations: [],
      relationsFailed: [],
      created: 1,
    } as never);
  const result = await submitCaptureGraph({
    userId: "user-1",
    agentUserId: "agent-1",
    workspaceId: null,
    entities: [
      { ref: "p1", profileSlug: "person", title: "Jane Doe", properties: {} },
    ] as never,
  } as never);
  return { result, pending, receipt, materialize };
}

describe("submitCaptureGraph — the one duplicate door", () => {
  it("a same-name record is NOT linked; the agent's graph is filed for review", async () => {
    vi.mocked(resolveIdentity).mockResolvedValue({
      match: "weak",
      entity: JANE,
      candidates: [JANE],
      crossKindCandidates: [],
    } as never);
    const { result, pending, receipt } = await capture();

    expect(receipt).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(pending).toHaveBeenCalledTimes(1);
    const filed = pending.mock.calls[0]![0];
    expect(filed.governanceReason).toBe("POSSIBLE_DUPLICATE");
    const ops = filed.data.operations as Array<Record<string, unknown>>;
    expect(ops[0]!.existingEntityId).toBeUndefined();
    expect(filed.data.duplicateCheck).toEqual({
      status: "possible",
      subject: "entity",
      candidates: [
        {
          ref: "record",
          id: JANE.id,
          kind: "person",
          title: "Jane Doe",
          why: "same_name",
          forRef: "p1",
          forTitle: "Jane Doe",
        },
      ],
    });
    expect(result.duplicateCheck?.status).toBe("possible");
  });

  it("no twin: the agent's graph still auto-applies, and says it looked", async () => {
    vi.mocked(resolveIdentity).mockResolvedValue({
      match: null,
      candidates: [],
      crossKindCandidates: [],
    } as never);
    const { result, receipt, pending } = await capture();
    expect(result.applied).toBe(true);
    expect(pending).not.toHaveBeenCalled();
    const data = receipt.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.duplicateCheck).toMatchObject({ status: "clear" });
    expect(result.duplicateCheck).toBeUndefined();
  });
});
