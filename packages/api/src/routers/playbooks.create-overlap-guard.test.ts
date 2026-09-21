/**
 * "Discover before inventing", enforced at the playbook create door.
 *
 * MEASURED DEFECT (live, 2026-09-21). The CRM workspace already held "Qualify a
 * CRM lead", "Enrich Lead/Company", "Lead Outreach" and "CRM Hygiene". An agent
 * created "Lead -> qualified (discovery)" — overlapping three of them — and the
 * pod accepted it silently. The exact-name idempotency directly above this
 * guard could not see it, because a near-twin arrives under a DIFFERENT name.
 *
 * THE FIXTURE IS THE REAL DATA. The candidate rows below are the actual names,
 * descriptions and goal templates from the CRM workspace, and the duplicate is
 * the actual playbook the agent filed. A hand-invented "Playbook A" / "Playbook
 * B" fixture would prove the threshold works on a case nobody will ever hit;
 * these rows are the case that DID happen.
 *
 * WHAT THIS DOES NOT COVER, measured: the DB is mocked, so this exercises the
 * ranking + threshold + control flow, not Postgres. The threshold itself is a
 * tuned constant — the two tests that matter are the pair below, a real
 * duplicate that MUST be refused and a real distinct playbook in the same
 * workspace that MUST still be allowed. One without the other proves nothing:
 * a threshold of 0 passes the first, and a threshold of infinity passes the
 * second.
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

function aiCtx() {
  return { authenticated: true, userId: "user-1", workspaceId: WS } as never;
}

/** VERBATIM from the live CRM workspace (synap_list_playbooks, 2026-09-21). */
const LIVE_CRM_PLAYBOOKS = [
  {
    id: "dcbdbb10-958d-4d81-a9ef-2d7958dc2f09",
    name: "Qualify a CRM lead",
    description:
      "Research and qualify one CRM lead, then make the next action explicit without creating a commercial proposal automatically.",
    goalTemplate:
      "Work on CRM lead ({lead}). Verify and enrich only factual information that can be supported, assess fit, and update its CRM lifecycle stage, ICP score, qualification notes, outreach channels, and next action.",
  },
  {
    id: "1c96e9fb-76db-4958-b103-83d6e4a330c2",
    name: "Enrich Lead/Company",
    description:
      "Enrich a lead or company from public sources — firmographics, company size, and recent signal — to sharpen ICP scoring and qualification.",
    goalTemplate: "Enrich {target} using public sources.",
  },
  {
    id: "26d5f5be-31f3-4aec-a50c-6c0f21d5e80f",
    name: "CRM Hygiene",
    description:
      "Always-on maintenance — enriches stale contacts/companies and flags stalled deals.",
    goalTemplate:
      "You are the CRM hygiene maintenance agent, running unattended on a daily schedule.",
  },
  {
    id: "bb8aa897-7f17-4c3b-8ad1-e92c882da504",
    name: "Advance a commercial proposal",
    description:
      "Help progress a linked deal without confusing commercial state with the lead pipeline or client conversion.",
    goalTemplate:
      "Work on commercial proposal ({deal}). Confirm its primary counterparty, current commercial stage, fee model.",
  },
];

/** The playbook the agent actually filed on 2026-09-20. */
const THE_DUPLICATE = {
  name: "Lead → qualified (discovery)",
  description:
    "The repeatable motion for taking one sourced lead through to qualified-or-dead, for both the Architech firm segment and the creator/operator segment.",
  goalTemplate:
    "Qualify {{lead}} ({{segment}}) — source, enrich, reach out, run discovery, decide",
  status: "active" as const,
  executor: "is-agent" as const,
  agentUserId: "00000000-0000-4000-8000-00000000a9e7",
};

/** A genuinely different motion, same workspace — must NOT be refused. */
const A_DISTINCT_PLAYBOOK = {
  name: "Quarterly revenue forecast",
  description:
    "Roll up open deals into a weighted forecast for the quarter and flag the gap to target.",
  goalTemplate:
    "Build the quarterly forecast from open deals and report the gap to target.",
  status: "active" as const,
  executor: "is-agent" as const,
  agentUserId: "00000000-0000-4000-8000-00000000a9e7",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPermission.mockResolvedValue({ granted: true });
  mockPreviewDecision.mockResolvedValue({ decision: "propose" });
  profilesFindMany.mockResolvedValue([{ id: "p-1", profileKind: "kind" }]);
  insertReturning.mockResolvedValue([{ id: "pb-new", name: "new" }]);
  // `select()` is used by BOTH the exact-name lookup (which ends in .limit)
  // and the overlap scan (which does not). Return no exact-name match, and the
  // live rows for the overlap scan.
  selectLimit.mockResolvedValue([]);
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
      then: (resolve: (v: unknown) => unknown) => resolve(LIVE_CRM_PLAYBOOKS),
    };
    return chain;
  });
});

describe("playbooks.create refuses a near-duplicate for an AI caller", () => {
  it("THE REAL CASE: the playbook the agent actually filed is REFUSED, naming the matches", async () => {
    await expect(
      playbooksRouter.createCaller(aiCtx()).create(THE_DUPLICATE as never)
    ).rejects.toThrow(/Qualify a CRM lead/);
    expect(
      insertReturning,
      "a near-duplicate playbook was written anyway"
    ).not.toHaveBeenCalled();
  });

  it("THE OTHER HALF: a genuinely distinct playbook in the SAME workspace is allowed", async () => {
    // Without this, a threshold of zero would pass the test above. Measured
    // 2026-09-21: this scores 21.1/term against its nearest neighbour, versus
    // 47.0/term for the real duplicate. The guard refuses at 30.
    const res = await playbooksRouter
      .createCaller(aiCtx())
      .create(A_DISTINCT_PLAYBOOK as never);
    expect(res.status).toBe("created");
    expect(insertReturning).toHaveBeenCalled();
  });

  it("forceCreate is the escape hatch, exactly as on entities.create", async () => {
    const res = await playbooksRouter
      .createCaller(aiCtx())
      .create({ ...THE_DUPLICATE, forceCreate: true } as never);
    expect(res.status).toBe("created");
  });

  it("a HUMAN caller is never second-guessed", async () => {
    // Template installs, reconcilers, marketplace applies and human authors all
    // create deliberately. Only the AI branch runs the check.
    const res = await playbooksRouter
      .createCaller(aiCtx())
      .create({
        ...THE_DUPLICATE,
        agentUserId: undefined,
        source: "user",
      } as never);
    expect(res.status).toBe("created");
  });

  it("the refusal carries machine-readable candidates, not just a sentence", async () => {
    const err = await playbooksRouter
      .createCaller(aiCtx())
      .create(THE_DUPLICATE as never)
      .catch((e: { cause?: { overlapping?: Array<{ id: string }> } }) => e);
    const overlapping = (
      err as { cause?: { overlapping?: Array<{ id: string }> } }
    ).cause?.overlapping;
    expect(
      overlapping,
      "no candidates on the error — the agent cannot act on it"
    ).toBeDefined();
    expect(overlapping!.length).toBeGreaterThan(0);
    expect(overlapping!.length).toBeLessThanOrEqual(3);
    expect(overlapping![0]!.id).toBe("dcbdbb10-958d-4d81-a9ef-2d7958dc2f09");
  });
});
