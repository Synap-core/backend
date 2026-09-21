/**
 * A playbook may not be written with a `subjectProfile` naming a slug that
 * resolves to no profile.
 *
 * MEASURED DEFECT (live, 2026-09-21): the shipped CRM playbook "Qualify a CRM
 * lead" carries `subjectProfile: { profileSlug: "crm-lead" }` and NO profile
 * with that slug exists in the pod. `matchForEntity` keys candidates off
 * `subjectProfile->>'profileSlug'`, so the playbook can never match anything —
 * it is permanently, SILENTLY unusable. Nothing validated the reference when
 * it was written.
 *
 * Same class as the twin-slug `finding` bug: a stored CONFIG holds a slug
 * reference and nobody checks it at write time.
 *
 * WHAT THIS DOES NOT COVER, measured: the DB is mocked, so this asserts the
 * door's control flow (refuse before gate, refuse before insert), not Postgres
 * behaviour. It also does not retro-validate the ~7 playbooks already in the
 * pod — that is a data repair, not a guard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDb,
  profilesFindMany,
  mockGetDb,
  mockCheckPermission,
  mockPreviewDecision,
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
  const profilesFindMany = vi.fn();
  const mockDb = {
    insert: vi.fn(() => insertChain),
    select: vi.fn(() => selectChain),
    query: {
      // `assertKnownProfileSlug` -> `profileSlugRows` -> this call.
      profiles: { findMany: profilesFindMany },
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
    profilesFindMany,
    insertReturning,
    selectLimit,
    mockMaterializeCron: vi.fn().mockResolvedValue(undefined),
    mockCreateLinks: vi.fn().mockResolvedValue([]),
    mockCheckPermission: vi.fn().mockResolvedValue({ granted: true }),
    mockPreviewDecision: vi.fn().mockResolvedValue({ decision: "propose" }),
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

// TOTAL mock: every export the router reaches for must be listed, or a NEW
// import in the router fails here at call time with "No export is defined on
// the mock" — which is how `proposedMessageFor` broke this suite.
// PARTIAL mock (importOriginal + spread), not a total replacement: the
// `total-mock-missing-export-ratchet` tripwire counts total factories that omit
// a name their module imports, and a total mock here silently drops whatever
// `playbooks.ts` imports next — the failure mode being that the file dies at
// COLLECTION, which reads as a pass in a summary.
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: mockCheckPermission,
    previewPermissionDecision: mockPreviewDecision,
  };
});

vi.mock("../services/playbooks/cron-automation.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/playbooks/cron-automation.js")
    >();
  return { ...actual, materializePlaybookCronAutomation: mockMaterializeCron };
});

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

const WS = "00000000-0000-4000-8000-000000000010";

function callerCtx() {
  return { authenticated: true, userId: "user-1", workspaceId: WS } as never;
}

const base = {
  name: "Qualify a CRM lead",
  goalTemplate: "Qualify {{subject}}",
  status: "active" as const,
  executor: "is-agent" as const,
};

/** The slug resolves to a real kind row. */
const slugResolves = () =>
  profilesFindMany.mockResolvedValue([{ id: "p-1", profileKind: "kind" }]);
/** The slug resolves to nothing — the `crm-lead` case. */
const slugDangles = () => profilesFindMany.mockResolvedValue([]);

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ granted: true });
  selectLimit.mockResolvedValue([]);
  insertReturning.mockResolvedValue([{ id: "pb-1", name: base.name }]);
  profilesFindMany.mockResolvedValue([]);
});

describe("playbooks.create refuses a dangling subjectProfile", () => {
  it("NON-VACUITY: the same create SUCCEEDS when the slug resolves", async () => {
    // Without this, a create that throws for some unrelated reason would make
    // every rejection assertion below pass while proving nothing.
    slugResolves();
    const res = await playbooksRouter
      .createCaller(callerCtx())
      .create({ ...base, subjectProfile: { profileSlug: "lead" } } as never);
    expect(res.status).toBe("created");
    expect(insertReturning).toHaveBeenCalled();
  });

  it("THE CASE: a slug that resolves to nothing is REFUSED", async () => {
    slugDangles();
    await expect(
      playbooksRouter
        .createCaller(callerCtx())
        .create({
          ...base,
          subjectProfile: { profileSlug: "crm-lead" },
        } as never)
    ).rejects.toThrow(/crm-lead/);
  });

  it("refuses BEFORE the governance gate — no unapprovable proposal is filed", async () => {
    // The point of the placement: an agent's bad slug must not become a review
    // item that could only ever fail at approve time.
    slugDangles();
    await expect(
      playbooksRouter
        .createCaller(callerCtx())
        .create({
          ...base,
          subjectProfile: { profileSlug: "crm-lead" },
        } as never)
    ).rejects.toThrow();
    expect(
      mockCheckPermission,
      "the gate ran for a playbook that can never be valid"
    ).not.toHaveBeenCalled();
    expect(insertReturning).not.toHaveBeenCalled();
  });

  it("a create with NO subjectProfile does not even look a slug up", async () => {
    const res = await playbooksRouter
      .createCaller(callerCtx())
      .create({ ...base } as never);
    expect(res.status).toBe("created");
    expect(profilesFindMany).not.toHaveBeenCalled();
  });

  it("a subjectProfile bag with no profileSlug key is left alone", async () => {
    // The column is a free JSON bag; this guard makes no claim about the rest.
    const res = await playbooksRouter
      .createCaller(callerCtx())
      .create({ ...base, subjectProfile: { note: "freeform" } } as never);
    expect(res.status).toBe("created");
    expect(profilesFindMany).not.toHaveBeenCalled();
  });
});
