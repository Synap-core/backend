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
  db: {},
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
  },
  workspaces: {},
  messages: {},
  notifications: {},
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("./channels.js", () => ({ channelsRouter: {} }));
vi.mock("./entities.js", () => ({ entitiesRouter: {} }));
vi.mock("./relations.js", () => ({ relationsRouter: {} }));
vi.mock("./documents.js", () => ({ documentsRouter: {} }));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
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

import { planProposalRevert } from "./proposals.js";

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

  it("FAILS LOUD on a delete proposal (hard delete, nothing to restore)", () => {
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
