/**
 * proposals.revert — planner unit tests
 *
 * Exercises the PURE inverse-planner (`planProposalRevert`) that decides, from a
 * proposal's own stored data, whether a revert is supported and what rows to
 * delete. This is the fail-loud gate: update/delete proposals (no before-state)
 * and creates with no recorded ids must be `unsupported`.
 *
 * Pure logic only — no DB. The heavy router (entity/relation/document callers)
 * is mocked away so importing the module under test stays cheap & deterministic.
 */

import { describe, it, expect, vi } from "vitest";

// proposals.ts imports many DB-backed routers at module load. Stub the ones that
// would otherwise pull in postgres/storage so the pure planner is importable in
// isolation. The planner itself touches none of these.
vi.mock("@synap/database", () => ({
  db: {
    query: { proposals: { findFirst: vi.fn() } },
    select: vi.fn(),
    update: vi.fn(),
  },
  EventRepository: class {},
  proposals: {},
  documents: {},
  documentVersions: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  entities: {},
  users: {},
  getWorkspaceMembership: vi.fn(),
  normalizeDocumentType: vi.fn(),
  storedVersionValues: vi.fn(),
  uploadDocumentVersionSnapshot: vi.fn(),
  ProfileResolutionService: class {},
  sql: {},
}));
vi.mock("@synap/database/schema", () => ({
  ProposalStatus: {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
    AUTO_APPROVED: "auto_approved",
    REVERTED: "reverted",
  },
  workspaces: {},
  messages: {},
  notifications: {},
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("./channels.js", () => ({ channelsRouter: {} }));
vi.mock("./entities.js", () => ({
  entitiesRouter: { createCaller: () => ({ delete: vi.fn() }) },
}));
vi.mock("./relations.js", () => ({
  relationsRouter: { createCaller: () => ({ delete: vi.fn() }) },
}));
vi.mock("./documents.js", () => ({
  documentsRouter: { createCaller: () => ({ delete: vi.fn() }) },
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: vi.fn(),
}));
vi.mock("../utils/materialize-composite.js", () => ({
  materializeCompositeGraph: vi.fn(),
}));
vi.mock("../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: vi.fn(),
}));
vi.mock("../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { db } from "@synap/database";
import { proposalsRouter } from "./proposals.js";
import { planProposalRevert, buildProposalChanges } from "./proposals.js";

describe("planProposalRevert", () => {
  it("revert of a single-entity create soft-deletes the created entity (from materialized)", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "entity",
      targetId: "00000000-0000-0000-0000-0000000000aa", // proposal target (a placeholder)
      proposalType: "create",
      data: {
        materialized: { entityIds: ["11111111-1111-1111-1111-111111111111"] },
      },
    });
    expect(plan.kind).toBe("delete-creations");
    if (plan.kind === "delete-creations") {
      expect(plan.entityIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
      expect(plan.relationIds).toEqual([]);
      expect(plan.documentIds).toEqual([]);
    }
  });

  it("revert of a composite create deletes every materialized entity id", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "entity",
      targetId: "t-0",
      proposalType: "create_composite",
      data: {
        operations: [
          { op: "create_entity", profileSlug: "question", title: "Q" },
          { op: "create_entity", profileSlug: "note", title: "N" },
          {
            op: "create_relation",
            type: "answers",
            sourceRef: "$op1",
            targetRef: "$op0",
          },
        ],
        materialized: {
          entityIds: ["aaa", "bbb"],
          relationIds: ["rel-1"],
        },
      },
    });
    expect(plan.kind).toBe("delete-creations");
    if (plan.kind === "delete-creations") {
      expect(plan.entityIds).toEqual(["aaa", "bbb"]);
      expect(plan.relationIds).toEqual(["rel-1"]);
    }
  });

  it("falls back to targetId for a generic create with no materialized record", () => {
    const plan = planProposalRevert({
      status: "auto_approved",
      targetType: "entity",
      targetId: "22222222-2222-2222-2222-222222222222",
      proposalType: "create",
      data: {
        requestId: "r1",
        targetType: "entity",
        changeType: "create",
        data: { id: "22222222-2222-2222-2222-222222222222" },
      },
    });
    expect(plan.kind).toBe("delete-creations");
    if (plan.kind === "delete-creations") {
      expect(plan.entityIds).toEqual(["22222222-2222-2222-2222-222222222222"]);
    }
  });

  it("FAILS LOUD on an update proposal (no before-snapshot)", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "entity",
      targetId: "33333333-3333-3333-3333-333333333333",
      proposalType: "update",
      data: {
        requestId: "r2",
        targetType: "entity",
        changeType: "update",
        data: { id: "33333333-3333-3333-3333-333333333333", title: "new" },
      },
    });
    expect(plan.kind).toBe("unsupported");
    if (plan.kind === "unsupported") {
      expect(plan.reason).toMatch(/before-snapshot/i);
    }
  });

  it("plans a restore for an entity delete proposal (entity deletes are soft-deletes)", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "entity",
      targetId: "44444444-4444-4444-4444-444444444444",
      proposalType: "delete",
      data: {
        requestId: "r3",
        targetType: "entity",
        changeType: "delete",
        data: { id: "44444444-4444-4444-4444-444444444444" },
      },
    });
    expect(plan).toEqual({
      kind: "restore-delete",
      entityId: "44444444-4444-4444-4444-444444444444",
    });
  });

  it("FAILS LOUD on a non-entity delete proposal (relation/document deletes are hard deletes)", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "relation",
      targetId: "66666666-6666-6666-6666-666666666666",
      proposalType: "delete",
      data: {
        requestId: "r5",
        targetType: "relation",
        changeType: "delete",
        data: { id: "66666666-6666-6666-6666-666666666666" },
      },
    });
    expect(plan.kind).toBe("unsupported");
    if (plan.kind === "unsupported") {
      expect(plan.reason).toMatch(/delete/i);
    }
  });

  it("FAILS LOUD on a create with no created ids and no recoverable target", () => {
    const plan = planProposalRevert({
      status: "approved",
      targetType: "relation", // not entity/document → no targetId fallback
      targetId: "55555555-5555-5555-5555-555555555555",
      proposalType: "create",
      data: { requestId: "r4", targetType: "relation", changeType: "create" },
    });
    expect(plan.kind).toBe("unsupported");
  });
});

describe("proposalsRouter.revert — restoring an approved delete proposal", () => {
  const entityId = "77777777-7777-7777-7777-777777777777";
  const proposalId = "88888888-8888-8888-8888-888888888888";

  function makeUpdateChain(returningRows: Array<{ id: string }>) {
    // `db.update(...).set(...).where(...)` is awaited directly by the entity
    // restore (no `.returning()` call); the proposal status flip additionally
    // calls `.returning()`. A promise with a `.returning()` property satisfies
    // both call shapes with one mock.
    const whereResult = Promise.resolve(undefined) as Promise<unknown> & {
      returning: () => Promise<Array<{ id: string }>>;
    };
    whereResult.returning = vi.fn().mockResolvedValue(returningRows);
    return { set: vi.fn(() => ({ where: vi.fn(() => whereResult) })) };
  }

  function setUpMocks(entityDeletedAt: Date | null) {
    (db as any).query.proposals.findFirst = vi.fn().mockResolvedValue({
      id: proposalId,
      status: "approved",
      targetType: "entity",
      targetId: entityId,
      proposalType: "delete",
      workspaceId: null,
      data: {
        requestId: "r-revert-1",
        targetType: "entity",
        changeType: "delete",
        data: { id: entityId },
      },
    });
    (db as any).select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi
            .fn()
            .mockResolvedValue([{ id: entityId, deletedAt: entityDeletedAt }]),
        })),
      })),
    }));
    (db as any).update = vi.fn(() => makeUpdateChain([{ id: proposalId }]));
  }

  it("clears deletedAt on the target entity and flips the proposal to reverted", async () => {
    setUpMocks(new Date("2026-01-01T00:00:00Z"));

    const caller = proposalsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
    } as any);

    const result = await caller.revert({ proposalId });

    expect(result.success).toBe(true);
    expect((result as any).restoredEntityId).toBe(entityId);

    // The entity restore is the FIRST db.update call; the proposal status
    // flip is the second.
    const updateCalls = (db.update as unknown as { mock: { calls: unknown[] } })
      .mock.calls;
    expect(updateCalls.length).toBe(2);
    const restoreSetCalls = (
      (db.update as any).mock.results[0].value.set as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls;
    expect(restoreSetCalls[0]?.[0]).toMatchObject({ deletedAt: null });
  });

  it("is idempotent when the entity was already restored (deletedAt already null)", async () => {
    setUpMocks(null);

    const caller = proposalsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
    } as any);

    const result = await caller.revert({ proposalId });

    expect(result.success).toBe(true);
    expect((result as any).restoredEntityId).toBe(entityId);
    // Only the proposal status flip should call db.update — no redundant
    // entity write when deletedAt is already null.
    expect((db.update as any).mock.calls.length).toBe(1);
  });

  it("fails loud when the entity row no longer exists (permanently purged)", async () => {
    setUpMocks(new Date());
    (db as any).select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]), // row gone — hard-purged
        })),
      })),
    }));

    const caller = proposalsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
    } as any);

    await expect(caller.revert({ proposalId })).rejects.toThrow(/purged/i);
  });
});

describe("buildProposalChanges — generic non-entity fallback", () => {
  it("flat property_def create payload yields one change per non-infra field", () => {
    const changes = buildProposalChanges(
      {
        slug: "budget",
        valueType: "number",
        constraints: { min: 0 },
        overlay: false,
        required: true,
        displayOrder: 3,
        // infra keys that must be filtered out
        workspaceId: "ws-1",
        correlationId: "corr-1",
        source: "intelligence",
      },
      "create"
    );

    expect(changes.length).toBeGreaterThan(0);
    const paths = changes.map((c) => c.path);
    // Meaningful, un-prefixed (NO "properties.") field paths surface…
    expect(paths).toContain("slug");
    expect(paths).toContain("valueType");
    expect(paths).toContain("required");
    // …and infra keys never leak as change rows.
    expect(paths).not.toContain("workspaceId");
    expect(paths).not.toContain("correlationId");
    expect(paths).not.toContain("source");

    const valueTypeChange = changes.find((c) => c.path === "valueType");
    expect(valueTypeChange?.after).toBe("number");
    expect(valueTypeChange?.operation).toBe("create");
  });

  it("entity create payload is unchanged by the fallback (only entity-shape + properties)", () => {
    const changes = buildProposalChanges(
      {
        title: "My Task",
        profileSlug: "task",
        properties: { status: "todo", priority: "high" },
      },
      "create"
    );
    const paths = changes.map((c) => c.path);
    // Entity path populates changes → the generic fallback never fires.
    expect(paths).toContain("title");
    expect(paths).toContain("profileSlug");
    expect(paths).toContain("properties.status");
    expect(paths).toContain("properties.priority");
    // No un-prefixed property leakage from the fallback.
    expect(paths).not.toContain("status");
    expect(paths).not.toContain("priority");
  });
});
