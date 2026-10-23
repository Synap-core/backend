/**
 * The playbook create door answers through the ONE duplicate door (FB1020 B2).
 *
 * HISTORY. On 2026-09-21 an agent filed "Lead -> qualified (discovery)" beside
 * "Qualify a CRM lead"; a term-overlap REFUSAL (IDF score per term, tuned on two
 * pairs) was added, with `forceCreate` as its escape. In the 10-20 dogfood it
 * refused a distinct motion ("Founder interview") twice until the agent
 * reworded it. Founder decision B2: a near match is FILED, never refused; the
 * reviewer decides; `forceCreate` is deleted. Every AI playbook create is a
 * proposal already (AGENT_STRUCTURE_WRITE), so what the door adds is the
 * "looks like X" answer on that proposal — today the same playbook still
 * waiting for review in the same space. A meaning-based match comes later.
 *
 * Rows:
 *  - the real 09-21 case is filed (gate reached), never refused;
 *  - a same-name pending playbook proposal in the SAME space is a possible
 *    twin, persisted for the card; in ANOTHER space it is not;
 *  - a human caller is not checked at all (unchanged).
 *
 * The DB is a chain stub: this covers the door's control flow at the router,
 * not Postgres (the pending scan's own rows are in the door's unit test).
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

vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
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
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => ({
        sql: strings.join("?"),
      })),
      // session-kind.ts builds a module-level drizzleSql.raw, and the jobs
      // session-titler a module-level drizzleSql.identifier
      {
        raw: vi.fn((s: string) => ({ sql: s })),
        identifier: vi.fn((s: string) => ({ sql: s })),
      }
    ),
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

function aiCtx() {
  return { authenticated: true, userId: "user-1", workspaceId: WS } as never;
}

const AGENT = "00000000-0000-4000-8000-00000000a9e7";

/** The playbook the agent actually filed on 2026-09-20. */
const THE_DUPLICATE = {
  name: "Lead → qualified (discovery)",
  description:
    "The repeatable motion for taking one sourced lead through to qualified-or-dead, for both the Architech firm segment and the creator/operator segment.",
  // {name} placeholders, declared (assertGoalPlaceholdersDeclared, 1c6193456).
  goalTemplate:
    "Qualify {lead} ({segment}) — source, enrich, reach out, run discovery, decide",
  params: [
    { name: "lead", type: "text" },
    { name: "segment", type: "text" },
  ],
  status: "active" as const,
  executor: "is-agent" as const,
  agentUserId: AGENT,
};

/** What every `select()` chain resolves to (awaited directly or via .limit). */
let rows: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mockCheckPermission.mockResolvedValue({
    proposalId: "prop-new",
    proposalType: "create",
  });
  mockPreviewDecision.mockResolvedValue({ decision: "propose" });
  profilesFindMany.mockResolvedValue([{ id: "p-1", profileKind: "kind" }]);
  insertReturning.mockResolvedValue([{ id: "pb-new", name: "new" }]);
  // `.limit(1)` is the exact-name record lookup (no record here); the pending
  // scan reads a wider window and gets `rows`.
  selectLimit.mockImplementation(async (n: number) => (n === 1 ? [] : rows));
  (
    mockDb.select as unknown as {
      mockImplementation: (f: () => unknown) => void;
    }
  ).mockImplementation(() => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      orderBy: () => chain,
      limit: selectLimit,
      where: () => chain,
      then: (resolve: (v: unknown) => unknown) => resolve(rows),
    };
    return chain;
  });
});

function pendingPlaybook(workspaceId: string) {
  return {
    id: "prop-twin",
    targetType: "playbook",
    proposalType: "create",
    workspaceId,
    data: { data: { name: THE_DUPLICATE.name } },
  };
}

function gateInput(): {
  possibleDuplicate?: boolean;
  duplicateCheck?: { status: string; candidates: Array<{ id: string }> };
} {
  expect(mockCheckPermission).toHaveBeenCalledTimes(1);
  return mockCheckPermission.mock.calls[0]![0];
}

describe("playbooks.create files a near twin for review", () => {
  it("THE REAL CASE is filed, never refused", async () => {
    const res = await playbooksRouter
      .createCaller(aiCtx())
      .create(THE_DUPLICATE as never);
    expect(res.status).toBe("proposed");
    expect(gateInput().duplicateCheck?.status).toBe("clear");
  });

  it("the same playbook waiting in the SAME space is a possible twin on the proposal", async () => {
    rows = [pendingPlaybook(WS)];
    await playbooksRouter.createCaller(aiCtx()).create(THE_DUPLICATE as never);
    const input = gateInput();
    expect(input.possibleDuplicate).toBe(true);
    expect(input.duplicateCheck).toMatchObject({
      status: "possible",
      subject: "playbook",
      candidates: [{ ref: "proposal", id: "prop-twin", why: "same_name" }],
    });
  });

  it("the same name waiting in ANOTHER space is not a twin", async () => {
    rows = [pendingPlaybook("00000000-0000-4000-8000-000000000099")];
    await playbooksRouter.createCaller(aiCtx()).create(THE_DUPLICATE as never);
    expect(gateInput().possibleDuplicate).toBe(false);
  });

  it("a HUMAN caller is not checked", async () => {
    rows = [pendingPlaybook(WS)];
    mockCheckPermission.mockResolvedValue({ granted: true });
    const res = await playbooksRouter.createCaller(aiCtx()).create({
      ...THE_DUPLICATE,
      agentUserId: undefined,
      source: "user",
    } as never);
    expect(res.status).toBe("created");
    expect(gateInput().duplicateCheck).toBeUndefined();
  });
});
