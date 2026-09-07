/**
 * Contract test for views.create — idempotency ABOVE the propose path.
 *
 * `views` has NO name-uniqueness index, so unlike playbooks/automations an
 * approved duplicate genuinely materialises a clone view, and an agent whose
 * create routes to a PROPOSAL used to file a fresh proposal on every retry
 * (payload dedup can't collapse LLM-authored prose — only the NAME is stable).
 *
 * The door now: dry-run the gate → deny throws FORBIDDEN *before* any existence
 * lookup → existence check on (workspaceId, lower(name), type) → existing row
 * returned without filing → otherwise the real gate, unchanged.
 *
 * DB is mocked — asserts control flow, not Postgres semantics.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const EXISTING_ID = "00000000-0000-4000-8000-0000000000bb";
const AGENT = "00000000-0000-4000-8000-0000000000a1";

const {
  mockDb,
  mockGetDb,
  mockCheckPermission,
  mockPreviewDecision,
  selectLimit,
} = vi.hoisted(() => {
  const selectLimit = vi.fn().mockResolvedValue([]);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: selectLimit,
  };
  const mockDb = {
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    })),
    select: vi.fn(() => selectChain),
    query: {
      workspaceMembers: {
        findFirst: vi.fn().mockResolvedValue({ role: "editor" }),
      },
      workspaces: {
        findFirst: vi.fn().mockResolvedValue({ archivedAt: null }),
      },
    },
  };
  return {
    mockDb,
    selectLimit,
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockCheckPermission: vi.fn().mockResolvedValue({ granted: true }),
    mockPreviewDecision: vi.fn().mockResolvedValue({ decision: "propose" }),
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb, getDb: mockGetDb };
});

vi.mock("@synap/storage", () => ({
  storage: { buildPath: vi.fn(), upload: vi.fn() },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));

// importOriginal, NOT a hand-written export list: a total-replacement factory
// breaks every test in this file the moment the router imports one more name
// from this module (that is how `proposedMessageFor` broke it).
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: mockCheckPermission,
  previewPermissionDecision: mockPreviewDecision,
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue({ id: "evt-1" }),
}));

vi.mock("../lib/event-helpers.js", () => ({
  ViewEvents: { createRequested: vi.fn().mockResolvedValue(undefined) },
}));

import { viewsRouter } from "./views.js";

function callerCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never;
}

const agentInput = {
  name: "Pipeline board",
  type: "kanban" as const,
  scopeProfileIds: ["00000000-0000-4000-8000-0000000000c1"],
  agentUserId: AGENT,
  source: "ai" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([]);
  mockCheckPermission.mockResolvedValue({ granted: true });
  mockPreviewDecision.mockResolvedValue({ decision: "propose" });
});

describe("views.create — agent idempotency before the propose path", () => {
  it("a DENIED agent still gets FORBIDDEN — and learns nothing about existence", async () => {
    mockPreviewDecision.mockResolvedValue({
      decision: "deny",
      reason: "Permission denied",
    });

    const caller = viewsRouter.createCaller(callerCtx());
    await expect(caller.create(agentInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied",
    });

    // The existence lookup must NOT have run (no existence leak), and the
    // side-effecting gate must never have been reached.
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it("a permitted agent re-creating an existing (workspace, name, type) gets the row — NO proposal", async () => {
    selectLimit.mockResolvedValue([
      {
        id: EXISTING_ID,
        workspaceId: WORKSPACE,
        name: agentInput.name,
        type: "kanban",
        documentId: null,
      },
    ]);

    const caller = viewsRouter.createCaller(callerCtx());
    const result = await caller.create(agentInput);

    expect(result.status).toBe("created");
    expect((result.view as { id: string }).id).toBe(EXISTING_ID);
    // The real (side-effecting) gate is never reached → no duplicate proposal.
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it("a FIRST-TIME agent create still proposes exactly as before", async () => {
    selectLimit.mockResolvedValue([]);
    mockCheckPermission.mockResolvedValue({
      granted: false,
      proposalId: "prop-1",
      proposalType: "view.create",
      summary: "Create view",
      reasoning: "needs review",
      reviewPath: "/open/prop-1",
      reviewUrl: "https://pod/open/prop-1",
    });

    const caller = viewsRouter.createCaller(callerCtx());
    const result = await caller.create(agentInput);

    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("proposed");
    expect(result.proposalId).toBe("prop-1");
  });

  it("the propose gate stores the full config (not just name/type)", async () => {
    selectLimit.mockResolvedValue([]);
    mockCheckPermission.mockResolvedValue({
      granted: false,
      proposalId: "prop-cfg",
      proposalType: "view.create",
      summary: "Create view",
      reasoning: "needs review",
      reviewPath: "/open/prop-cfg",
      reviewUrl: "https://pod/open/prop-cfg",
    });

    const config = {
      blocks: [{ id: "b1", kind: "widget", widgetType: "stat-card" }],
    };
    const caller = viewsRouter.createCaller(callerCtx());
    await caller.create({ ...agentInput, config });

    const gate = mockCheckPermission.mock.calls[0]?.[0] as {
      data?: { id?: string; config?: unknown; name?: string };
    };
    expect(gate.data?.name).toBe(agentInput.name);
    expect(gate.data?.config).toEqual(config);
    expect(gate.data?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("a HUMAN create never dry-runs and never short-circuits on an existing name", async () => {
    // A same-named view exists; a human may legitimately want a second one, so
    // the lookup must not even happen.
    selectLimit.mockResolvedValue([{ id: EXISTING_ID, type: "kanban" }]);
    mockCheckPermission.mockResolvedValue({ granted: true });

    const caller = viewsRouter.createCaller(callerCtx());
    // Proceeds past the gate into the real create path (which then needs the
    // full repository stack) — we only assert the gate wiring here.
    await caller
      .create({ ...agentInput, agentUserId: undefined, source: "user" })
      .catch(() => undefined);

    expect(mockPreviewDecision).not.toHaveBeenCalled();
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
  });
});
