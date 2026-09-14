import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveGraphWorkspaceFromSlugs,
} from "@synap/database";

/**
 * THE GRAPH RECEIPT REPORTS THE ROW IT STORED — driven through the real
 * `submitCaptureGraph`, stubbed only at the row seams (the prior-proposal
 * lookup, the two proposal inserts, the materializer).
 *
 * Live, 2026-09-14 (proposal 7b8f4ff6): a re-send WITH `sessionId` hit the
 * idempotency dedup and returned the prior proposal — with a receipt naming the
 * CURRENT call's project (`resolvedProjectId`) and, when the prior row had no
 * session, the current call's session. A fresh write (aeca7cff) reported no
 * project over a row the insert filed through the declared-focus rung.
 *
 * Every fixture row carries values the INPUT does not, so an echo of the input
 * and a read of the row cannot pass the same assertion.
 */

const dbUpdates: unknown[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveGraphWorkspaceFromSlugs: vi.fn(),
    db: {
      ...actual.db,
      // The auto-apply path's `stampMaterialized` UPDATE.
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            dbUpdates.push(values);
          },
        }),
      }),
    },
  };
});

// The auto-apply receipt reads the agent's declared project focus (rung 3.5,
// A3 ladder parity). The spread `db` above has no drizzle `select`; no focus.
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-identity-service.js")>()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));

vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/database/agent-governance")>();
  return {
    ...actual,
    resolveAgentGovernanceDecision: vi
      .fn()
      .mockResolvedValue({ decision: "execute" }),
  };
});

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));

const { submitCaptureGraph } = await import("./submit-capture-graph.js");
const dedup = await import("../../utils/pending-capture-dedup.js");
const proposalWriter = await import("../../utils/event-backed-proposal.js");
const materializer = await import("../../utils/materialize-composite.js");

const ENTITIES = [
  { ref: "n1", profileSlug: "note", title: "Receipt truth", properties: {} },
] as never;

describe("submitCaptureGraph — the receipt reports the STORED row", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbUpdates.length = 0;
    vi.mocked(resolveGraphWorkspaceFromSlugs).mockResolvedValue(null);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as never);
  });

  it("(a) a dedup hit reports the PRIOR row's session and project, not this call's", async () => {
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue({
      id: "prop-prior",
      status: "pending",
      workspaceId: null,
      sessionId: "S-PRIOR",
      projectId: "P-PRIOR",
      data: { operations: [] },
    } as never);
    const insert = vi.spyOn(proposalWriter, "createEventBackedProposal");

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      sessionId: "S-REQUESTED",
      entities: ENTITIES,
    });

    expect(insert).not.toHaveBeenCalled();
    expect(result.proposalId).toBe("prop-prior");
    expect(result.deduped).toBe(true);
    expect(result.scope).toEqual({
      workspaceId: null,
      projectId: "P-PRIOR",
      sessionId: "S-PRIOR",
    });
    expect(result.sessionId).toBe("S-PRIOR");
    expect(result.writeReceipt.projectId).toBe("P-PRIOR");
  });

  it("(a') a prior row with NO session reports none — never this call's session", async () => {
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue({
      id: "prop-prior",
      status: "auto_approved",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      data: { operations: [] },
    } as never);

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      sessionId: "S-REQUESTED",
      entities: ENTITIES,
    });

    expect(result.sessionId).toBeNull();
    expect(result.scope.sessionId).toBeNull();
  });

  it("(b) a fresh pending write reports the project + session the INSERT chose (declared focus, minted receipt session)", async () => {
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
    // The insert ran rung 3.5 (declared focus) and minted an agent receipt
    // session: neither is in the input below.
    vi.spyOn(proposalWriter, "createEventBackedProposal").mockResolvedValue({
      proposal: {
        id: "prop-fresh",
        workspaceId: null,
        projectId: "P-FOCUS",
        sessionId: "S-MINTED",
      },
    } as never);

    const result = await submitCaptureGraph({
      userId: "user-1",
      workspaceId: null,
      entities: ENTITIES,
    });

    expect(result.deduped).toBeUndefined();
    expect(result.scope).toEqual({
      workspaceId: null,
      projectId: "P-FOCUS",
      sessionId: "S-MINTED",
    });
    expect(result.sessionId).toBe("S-MINTED");
    expect(result.writeReceipt.projectId).toBe("P-FOCUS");
  });

  it("an auto-applied graph reports its receipt row's scope", async () => {
    vi.spyOn(dedup, "findPriorCaptureGraphProposal").mockResolvedValue(null);
    vi.spyOn(proposalWriter, "createAutoApprovedProposal").mockImplementation(
      async (input) =>
        ({
          proposal: {
            id: input.id,
            data: input.data,
            workspaceId: null,
            projectId: "P-RECEIPT-ROW",
            sessionId: "S-RECEIPT-ROW",
          },
        }) as never
    );
    vi.spyOn(materializer, "materializeCompositeGraph").mockResolvedValue({
      entities: [{ ref: "n1", entityId: "entity-1", linked: false }],
      relations: [],
      relationsFailed: [],
      projects: [],
      sessions: [],
      documents: [],
      created: 1,
    } as never);

    const result = await submitCaptureGraph({
      userId: "user-1",
      agentUserId: "agent-1",
      workspaceId: null,
      sessionId: "S-INPUT",
      entities: ENTITIES,
    });

    // Branch proof: only the auto-apply terminal returns `applied: true`.
    expect(result.applied).toBe(true);
    expect(result.scope).toEqual({
      workspaceId: null,
      projectId: "P-RECEIPT-ROW",
      sessionId: "S-RECEIPT-ROW",
    });
    expect(result.writeReceipt.projectId).toBe("P-RECEIPT-ROW");
  });
});
