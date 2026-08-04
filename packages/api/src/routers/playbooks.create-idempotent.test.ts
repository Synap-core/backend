/**
 * Contract test for playbooks.create TOCTOU race recovery (0227).
 *
 * When a concurrent create wins `playbooks_workspace_name_active_uq`, the
 * losing insert raises SQLSTATE 23505. Create must re-select the survivor and
 * return it (status "created", same message surface) WITHOUT re-materializing
 * cron automations or context skills.
 *
 * DB is mocked — asserts control flow, not Postgres index semantics.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const WINNER_ID = "00000000-0000-4000-8000-0000000000aa";

const {
  mockDb,
  mockGetDb,
  mockCheckPermission,
  mockMaterializeCron,
  mockCreateLinks,
  insertReturning,
  selectLimit,
} = vi.hoisted(() => {
  const insertReturning = vi.fn();
  const selectLimit = vi.fn();
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: selectLimit,
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: insertReturning,
  };
  const mockDb = {
    insert: vi.fn(() => insertChain),
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
    insertReturning,
    selectLimit,
    mockMaterializeCron: vi.fn().mockResolvedValue(undefined),
    mockCreateLinks: vi.fn().mockResolvedValue([]),
    mockCheckPermission: vi.fn().mockResolvedValue({ granted: true }),
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
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
  return {
    ...actual,
    db: mockDb,
    getDb: mockGetDb,
    and: vi.fn((...c: unknown[]) => ({ and: c })),
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    asc: vi.fn((a: unknown) => ({ asc: a })),
    desc: vi.fn((a: unknown) => ({ desc: a })),
    drizzleSql: vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => ({
      sql: strings.join("?"),
    })),
  };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 0,
  })),
  invalidateSyncGenerationCache: vi.fn(),
}));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));

vi.mock("../services/playbooks/cron-automation.js", () => ({
  materializePlaybookCronAutomation: mockMaterializeCron,
}));

vi.mock("../services/links/links-service.js", () => ({
  getLinksFor: vi.fn().mockResolvedValue([]),
  createLinks: mockCreateLinks,
  extractCapabilities: vi.fn().mockReturnValue([]),
}));

vi.mock("../access/index.js", () => ({
  AccessContext: { from: vi.fn((ctx: unknown) => ctx) },
  scopedDb: vi.fn(() => ({
    predicate: vi.fn(() => ({ __visibility: true })),
    findFirst: vi.fn(),
  })),
}));

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/workspace-role.js", () => ({
  getWorkspaceRole: vi.fn().mockResolvedValue("owner"),
  requirePodAdmin: vi.fn(),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(),
}));

import { playbooksRouter } from "./playbooks.js";

function callerCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never;
}

const createInput = {
  name: "Qualify a CRM lead",
  goalTemplate: "Qualify {{subject}}",
  status: "active" as const,
  executor: "is-agent" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ granted: true });
});

describe("playbooks.create — name uniqueness / 23505 recovery", () => {
  it("returns the inserted row on a clean create and materializes cron side-effects", async () => {
    const row = {
      id: "pb-new",
      workspaceId: WORKSPACE,
      name: createInput.name,
      goalTemplate: createInput.goalTemplate,
      status: "active",
      params: [],
      schedule: null,
    };
    insertReturning.mockResolvedValueOnce([row]);

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.create(createInput);

    expect(result.status).toBe("created");
    expect(result.playbook?.id).toBe("pb-new");
    expect(result.message).toBe("Playbook created");
    expect(mockMaterializeCron).toHaveBeenCalledTimes(1);
  });

  it("on concurrent unique violation returns the existing non-archived winner without side-effects", async () => {
    const dup = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    insertReturning.mockRejectedValueOnce(dup);

    const winner = {
      id: WINNER_ID,
      workspaceId: WORKSPACE,
      name: createInput.name,
      goalTemplate: "Qualify {{subject}}",
      status: "active",
      params: [],
      createdAt: new Date("2026-01-01"),
    };
    selectLimit.mockResolvedValueOnce([winner]);

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.create(createInput);

    expect(result.status).toBe("created");
    expect(result.playbook?.id).toBe(WINNER_ID);
    expect(result.message).toMatch(/idempotent/i);
    // Must NOT re-materialize cron or attach context skills on reuse.
    expect(mockMaterializeCron).not.toHaveBeenCalled();
    expect(mockCreateLinks).not.toHaveBeenCalled();
  });

  it("re-throws non-unique insert errors", async () => {
    insertReturning.mockRejectedValueOnce(new Error("connection reset"));
    const caller = playbooksRouter.createCaller(callerCtx());
    await expect(caller.create(createInput)).rejects.toThrow(
      /connection reset/
    );
  });

  it("re-throws 23505 when winner lookup finds nothing (index drift)", async () => {
    const dup = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    insertReturning.mockRejectedValueOnce(dup);
    selectLimit.mockResolvedValueOnce([]);

    const caller = playbooksRouter.createCaller(callerCtx());
    await expect(caller.create(createInput)).rejects.toThrow(/duplicate key/);
  });
});
