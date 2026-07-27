/**
 * permission-check.ts — Unit Tests
 *
 * Covers the pure-logic gates that were added/changed:
 *   - CBAC: capability allowlist enforcement
 *   - writesRequireProposal: assistant-template write gate
 *   - ADMIN_ACTIONS: always-propose regardless of whitelist / writesRequireProposal flag
 *   - buildProposalSummary: label composition helper
 *
 * Heavy I/O paths (DB inserts, broadcastNotification, emitSideEffects) are
 * mocked so these remain fast, deterministic unit tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock every module that touches the DB or external services
// ---------------------------------------------------------------------------

// vi.hoisted ensures these refs exist before the vi.mock factory is hoisted
// to the top of the file (vitest hoists vi.mock calls at transform time, which
// runs before const declarations in module scope).
const {
  mockVerifyPermission,
  mockDbSelect,
  mockDbInsert,
  mockResolveProfile,
  mockFocusSessionFindFirst,
} = vi.hoisted(() => ({
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  // Default: profile resolves (existing profile). Individual tests override
  // to null to exercise the missing-profile guardrail.
  mockResolveProfile: vi
    .fn()
    .mockResolvedValue({ id: "profile-1", slug: "task" }),
  // Session lookup for deriveSessionForceProposeGovernance. Default: no session
  // (undefined) → no forced proposal, so every existing test is unaffected. The
  // session-force-propose test overrides it with a stamped session.
  mockFocusSessionFindFirst: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@synap/database", async () => {
  const { randomUUID } = await import("crypto");
  mockDbInsert.mockImplementation(() => ({
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
    catch: vi.fn().mockReturnThis(),
  }));
  mockDbSelect.mockImplementation(() => {
    // Chainable AND thenable: `.where(...)` awaited directly (the agent daily
    // proposal-budget count query) resolves to [] → count 0; `.limit(...)` still
    // resolves []. `.orderBy(...)` supports the personal-agent attribution lookup.
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue([]),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  });
  return {
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      // Run the callback with a tx that proxies insert (mirrors TX-1's atomic
      // proposal+.requested path); return whatever the callback returns.
      transaction: vi.fn(async (cb) => cb({ insert: mockDbInsert })),
      // Drizzle query API — only focusSessions.findFirst is used by the gate
      // (deriveSessionForceProposeGovernance re-reads the run session's stamp).
      query: {
        focusSessions: { findFirst: mockFocusSessionFindFirst },
      },
    },
    // Shared PENDING-proposal INSERT (SSOT in @synap/database) — the proposal
    // row shape createPendingProposal now delegates to. Returns
    // `{ proposal, deduped }` (the new dedup-aware contract), with a row id just
    // like the mocked `db.insert(...).returning()` above.
    insertPendingProposal: vi.fn().mockImplementation(async () => ({
      proposal: { id: randomUUID() },
      deduped: false,
    })),
    // G1 peek-before-event: createProposal calls this BEFORE stamping the
    // `.requested` event. Default: no existing duplicate → the normal insert
    // path runs (what these tests assert on).
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    proposals: {},
    entities: {},
    users: { id: "id", userType: "userType", agentMetadata: "agentMetadata" },
    workspaces: { id: "id", settings: "settings" },
    eq: vi.fn((a, b) => ({ field: a, value: b })),
    and: vi.fn((...conds) => ({ and: conds })),
    inArray: vi.fn((col, arr) => ({ inArray: [col, arr] })),
    gte: vi.fn((a, b) => ({ gte: [a, b] })),
    desc: vi.fn((a) => ({ desc: a })),
    isNotNull: vi.fn((a) => ({ isNotNull: a })),
    drizzleSql: vi.fn(() => ({})),
    verifyPermission: mockVerifyPermission,
    ProposalStatus: { PENDING: "pending", AUTO_APPROVED: "auto_approved" },
    ProfileResolutionService: class {
      resolveProfile = mockResolveProfile;
    },
  };
});

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(),
}));

vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: {
    fromProposal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("@synap-core/types", () => ({
  isLikelyUUID: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

import {
  ADMIN_ACTIONS,
  DEFAULT_AUTO_APPROVE,
  buildProposalSummary,
  buildProposalResponseFields,
  agentDailyProposalCap,
} from "./permission-check.js";

// We also need checkPermissionOrPropose for the integration-style unit tests.
// Import it separately so mocks are fully resolved first.
import { checkPermissionOrPropose } from "./permission-check.js";

// The mocked SSOT pending-proposal INSERT — asserted on to prove proposer stamping.
import { insertPendingProposal, eq as mockEq } from "@synap/database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure mockDbSelect so the first call returns an agent user row and
 * subsequent calls return a workspace-settings row. This matches the two
 * sequential selects inside checkPermissionOrPropose when agentUserId is set.
 */
function setupAgentSelectSequence(
  agentMetadata: Record<string, unknown>,
  workspaceSettings: Record<string, unknown> = {}
) {
  let callCount = 0;
  // Each builder is chainable + thenable: `.limit(...)` resolves the configured
  // row (agent row / workspace settings), while awaiting the builder directly
  // (the agent daily-budget count query — `.select().from().where()` with no
  // `.limit`) resolves to [] → count 0. `.orderBy(...)` supports the
  // personal-agent attribution lookup.
  const builder = (limitResult: unknown[]) => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue(limitResult),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  };
  mockDbSelect.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return builder([{ userType: "agent", agentMetadata }]) as any;
    }
    return builder([{ settings: workspaceSettings }]) as any;
  });
}

const BASE_OPTS = {
  userId: "user-abc",
  workspaceId: "ws-123",
  data: { id: "ent-xyz", title: "My Entity" },
} as const;

// ---------------------------------------------------------------------------
// Tests: buildProposalSummary (pure function, no mocks needed)
// ---------------------------------------------------------------------------

describe("buildProposalSummary", () => {
  it("capitalises action and includes quoted label when title is present", () => {
    const summary = buildProposalSummary("entity", "create", {
      title: "Task A",
    });
    expect(summary).toBe('Create entity "Task A"');
  });

  it("uses name field when title is absent", () => {
    const summary = buildProposalSummary("view", "update", {
      name: "Sprint Board",
    });
    expect(summary).toBe('Update view "Sprint Board"');
  });

  it("falls back to plain action + subjectType when no label fields are present", () => {
    const summary = buildProposalSummary("workspace", "delete", {});
    expect(summary).toBe("Delete workspace");
  });

  it("uses slug as label of last resort", () => {
    const summary = buildProposalSummary("profile", "create", { slug: "crm" });
    expect(summary).toBe('Create profile "crm"');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildProposalResponseFields (pure function)
// ---------------------------------------------------------------------------

describe("buildProposalResponseFields", () => {
  it("returns correct reviewPath and reviewUrl", () => {
    const result = buildProposalResponseFields({
      proposalId: "prop-001",
      subjectType: "entity",
      action: "delete",
      data: { title: "Q2 Plan" },
    });
    expect(result.reviewPath).toBe("/open/prop-001");
    expect(result.reviewUrl).toContain("/open/prop-001");
    expect(result.summary).toBe('Delete entity "Q2 Plan"');
  });

  it("uses explicit reasoning when provided", () => {
    const result = buildProposalResponseFields({
      proposalId: "prop-002",
      subjectType: "workspace",
      action: "update",
      data: {},
      reasoning: "Needs owner sign-off",
    });
    expect(result.reasoning).toBe("Needs owner sign-off");
  });

  it("generates default reasoning when none provided", () => {
    const result = buildProposalResponseFields({
      proposalId: "prop-003",
      subjectType: "entity",
      action: "create",
      data: {},
    });
    expect(result.reasoning).toMatch(/entity|create/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: ADMIN_ACTIONS constant
// ---------------------------------------------------------------------------

describe("ADMIN_ACTIONS", () => {
  it("includes workspace.update", () => {
    expect(ADMIN_ACTIONS).toContain("workspace.update");
  });

  it("includes workspace.delete", () => {
    expect(ADMIN_ACTIONS).toContain("workspace.delete");
  });

  it("includes agent lifecycle actions", () => {
    expect(ADMIN_ACTIONS).toContain("agent.create");
    expect(ADMIN_ACTIONS).toContain("agent.delete");
    expect(ADMIN_ACTIONS).toContain("agent.updateRole");
  });

  it("includes member management actions", () => {
    expect(ADMIN_ACTIONS).toContain("member.updateRole");
    expect(ADMIN_ACTIONS).toContain("member.remove");
    expect(ADMIN_ACTIONS).toContain("member.invite");
  });

  it("includes apiKey and intelligence actions", () => {
    expect(ADMIN_ACTIONS).toContain("apiKey.create");
    expect(ADMIN_ACTIONS).toContain("apiKey.revoke");
    expect(ADMIN_ACTIONS).toContain("intelligence.connect");
    expect(ADMIN_ACTIONS).toContain("intelligence.disconnect");
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_AUTO_APPROVE
// ---------------------------------------------------------------------------

describe("DEFAULT_AUTO_APPROVE", () => {
  it("includes entity.create and entity.read", () => {
    expect(DEFAULT_AUTO_APPROVE).toContain("entity.create");
    expect(DEFAULT_AUTO_APPROVE).toContain("entity.read");
  });

  it("does not include any ADMIN_ACTIONS entries", () => {
    for (const adminAction of ADMIN_ACTIONS) {
      expect(DEFAULT_AUTO_APPROVE).not.toContain(adminAction);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: checkPermissionOrPropose — no-workspaceId short-circuit
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — no workspaceId", () => {
  it("grants immediately when workspaceId is null (personal resource)", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: null,
      subjectType: "entity",
      action: "create",
      data: {},
    });
    expect(result).toEqual({ granted: true });
  });

  it("grants immediately when workspaceId is undefined", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: undefined,
      subjectType: "document",
      action: "create",
      data: {},
    });
    expect(result).toEqual({ granted: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: filesystem path blocklist
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — filesystem blocklist", () => {
  it("denies write to .env paths regardless of role", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: "ws-123",
      subjectType: "filesystem",
      action: "write",
      data: { path: "/home/user/project/.env.local" },
    });
    expect(result).toMatchObject({ denied: true });
    expect((result as { denied: true; reason: string }).reason).toMatch(
      /blocked/i
    );
  });

  it("denies write to synap-backend directory", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: "ws-123",
      subjectType: "filesystem",
      action: "write",
      data: { path: "/home/user/synap-backend/src/index.ts" },
    });
    expect(result).toMatchObject({ denied: true });
  });

  it("denies write to /etc/ system directory", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: "ws-123",
      subjectType: "filesystem",
      action: "write",
      data: { path: "/etc/passwd" },
    });
    expect(result).toMatchObject({ denied: true });
  });

  it("denies write to private key files", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-1",
      workspaceId: "ws-123",
      subjectType: "filesystem",
      action: "write",
      data: { path: "/home/user/.ssh/id_rsa" },
    });
    expect(result).toMatchObject({ denied: true });
  });
});

// ---------------------------------------------------------------------------
// Tests: CBAC capability enforcement
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — CBAC (capability-based access control)", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  it("denies when agent has capability list that excludes the requested action", async () => {
    setupAgentSelectSequence(
      { capabilities: ["entity.read"], writesRequireProposal: false },
      {}
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "entity",
      action: "create",
    });

    expect(result).toMatchObject({ denied: true });
    expect((result as { denied: true; reason: string }).reason).toMatch(
      /capability/i
    );
  });

  it("allows when agent has exact match capability for requested action", async () => {
    setupAgentSelectSequence(
      {
        capabilities: ["entity.read", "entity.create"],
        writesRequireProposal: false,
      },
      { aiGovernance: { autoApproveFor: ["entity.create"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result).toBe(false);
  });

  it("allows when agent has wildcard capability entity.* for entity.create", async () => {
    setupAgentSelectSequence(
      { capabilities: ["entity.*"], writesRequireProposal: false },
      { aiGovernance: { autoApproveFor: ["entity.create"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result).toBe(false);
  });

  it("allows when agent has *.* global wildcard", async () => {
    setupAgentSelectSequence(
      { capabilities: ["*.*"], writesRequireProposal: false },
      { aiGovernance: { autoApproveFor: ["workspace.create"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "workspace",
      action: "create",
    });

    // *.* passes CBAC, so the action proceeds to proposal/whitelist evaluation
    expect("denied" in result).toBe(false);
  });

  it("treats empty capabilities array as unrestricted (backwards compatibility)", async () => {
    setupAgentSelectSequence(
      { capabilities: [], writesRequireProposal: false },
      { aiGovernance: { autoApproveFor: ["entity.create"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result).toBe(false);
  });

  it("treats absent capabilities field as unrestricted", async () => {
    setupAgentSelectSequence(
      { writesRequireProposal: false },
      { aiGovernance: { autoApproveFor: ["entity.create"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: untrusted issuer (trust dimension)
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — issuer trust", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  it("proposes when issuer is untrusted, even though RBAC passes and there is no agent/AI source", async () => {
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      issuer: { kind: "view", trusted: false },
    });
    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("ignores a spoofed source on an untrusted issuer — still proposes", async () => {
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      source: "user", // body-declared source must not buy direct access
      issuer: { kind: "view", trusted: false },
    });
    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("grants directly when issuer is trusted (operator)", async () => {
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      issuer: { kind: "operator", trusted: true },
    });
    expect(result).toEqual({ granted: true });
  });

  it("preserves legacy behavior when no issuer is passed (grants)", async () => {
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
    });
    expect(result).toEqual({ granted: true });
  });

  it("still denies an untrusted issuer when RBAC fails (deny precedes propose)", async () => {
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "no write role",
    });
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      issuer: { kind: "view", trusted: false },
    });
    expect("denied" in result && result.denied === true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: writesRequireProposal (assistant template)
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — writesRequireProposal", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  it("creates a proposal when assistant agent performs entity.create", async () => {
    setupAgentSelectSequence({ writesRequireProposal: true }, {});

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-assistant-1",
      subjectType: "entity",
      action: "create",
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("creates a proposal when assistant agent performs document.update", async () => {
    setupAgentSelectSequence({ writesRequireProposal: true }, {});

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-assistant-1",
      subjectType: "document",
      action: "update",
    });

    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("allows entity.read without proposal even with writesRequireProposal=true", async () => {
    setupAgentSelectSequence(
      { writesRequireProposal: true },
      { aiGovernance: { autoApproveFor: ["entity.read"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-assistant-1",
      subjectType: "entity",
      action: "read",
    });

    // read is exempt from writesRequireProposal
    expect("denied" in result).toBe(false);
    if ("granted" in result) {
      expect(result.granted).toBe(true);
    }
  });

  it("allows search.* operations without proposal even with writesRequireProposal=true", async () => {
    setupAgentSelectSequence(
      { writesRequireProposal: true },
      { aiGovernance: { autoApproveFor: ["search.*"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-assistant-1",
      subjectType: "search",
      action: "entities",
    });

    expect("denied" in result).toBe(false);
  });

  it("allows memory.recall without proposal even with writesRequireProposal=true", async () => {
    setupAgentSelectSequence(
      { writesRequireProposal: true },
      { aiGovernance: { autoApproveFor: ["memory.recall"] } }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-assistant-1",
      subjectType: "memory",
      action: "recall",
    });

    expect("denied" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: session-scoped force-propose (CRM hygiene maintenance agent)
//
// PROOF that a propose-only maintenance session flips an otherwise-auto-approved
// agent write into a reviewable proposal. The ONLY difference between the two
// tests is whether the run's focus session carries
// `metadata.governance.forceProposeWrites` — same agent, same write, same empty
// governance metadata (so entity.update lands on DEFAULT_AUTO_APPROVE, rung 8).
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — session force-propose governance", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    // Clear call history too — this file has no global clearAllMocks, so the
    // short-circuit assertion below would otherwise see calls from sibling tests.
    mockFocusSessionFindFirst.mockReset().mockResolvedValue(undefined);
  });

  it("baseline: agent entity.update auto-approves (no session stamp)", async () => {
    setupAgentSelectSequence({}, {});

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-maintenance-1",
      subjectType: "entity",
      action: "update",
      sessionId: "sess-plain",
    });

    // entity.update ∈ DEFAULT_AUTO_APPROVE → granted, NOT a proposal.
    expect(result).toEqual({ granted: true });
  });

  it("stamped session forces the SAME write to a proposal", async () => {
    setupAgentSelectSequence({}, {});
    mockFocusSessionFindFirst.mockResolvedValue({
      metadata: { governance: { forceProposeWrites: true } },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-maintenance-1",
      subjectType: "entity",
      action: "update",
      sessionId: "sess-maintenance",
    });

    // Force-propose (rung 2.1) wins over DEFAULT_AUTO_APPROVE → proposal.
    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("explicit forcePropose:true short-circuits the session lookup", async () => {
    setupAgentSelectSequence({}, {});

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-maintenance-1",
      subjectType: "entity",
      action: "update",
      forcePropose: true,
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect(mockFocusSessionFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: ADMIN_ACTIONS always-propose gate
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — ADMIN_ACTIONS always propose", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  it("creates a proposal for workspace.update even when not an assistant agent", async () => {
    // twin: writesRequireProposal=false, no capability restriction
    setupAgentSelectSequence(
      { writesRequireProposal: false, agentTemplate: "twin" },
      {}
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-twin-1",
      subjectType: "workspace",
      action: "update",
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("creates a proposal for workspace.update even when workspace has broad auto-approve override", async () => {
    // workspace overrides auto-approve to include workspace.update — should still propose
    setupAgentSelectSequence(
      { writesRequireProposal: false },
      {
        aiGovernance: { autoApproveFor: ["workspace.update", "entity.create"] },
      }
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "workspace",
      action: "update",
    });

    // ADMIN_ACTIONS short-circuits before whitelist evaluation
    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("creates a proposal for member.invite regardless of agent flags", async () => {
    setupAgentSelectSequence({ writesRequireProposal: false }, {});

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-001",
      subjectType: "member",
      action: "invite",
    });

    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("creates a proposal for agent.create for twin agents (ADMIN_ACTIONS override twin flag)", async () => {
    // twin has writesRequireProposal=false but ADMIN_ACTIONS still gate
    setupAgentSelectSequence(
      { writesRequireProposal: false, agentTemplate: "twin" },
      {}
    );

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-twin-1",
      subjectType: "agent",
      action: "create",
    });

    expect("granted" in result && result.granted === false).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: entity-create profile-existence guardrail (fail-fast)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: F2 safety floor — per-user daily AGENT proposal cap
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — daily agent proposal cap (F2 floor)", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  /**
   * Mock the agent-row + workspace-settings selects (via `.limit`) AND the
   * agent daily-budget count query (the only select awaited directly, via
   * `.then`) so it resolves to `todayCount` proposals already filed today.
   * `writesRequireProposal` forces the governance decision to "propose".
   */
  function setupAgentBudget(
    todayCount: number,
    agentMetadata: Record<string, unknown> = { writesRequireProposal: true }
  ) {
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      const limitResult =
        callCount === 1
          ? [{ userType: "agent", agentMetadata }]
          : [{ settings: {} }];
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        limit: vi.fn().mockResolvedValue(limitResult),
        // The count query awaits the builder directly.
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve([{ count: todayCount }]).then(res, rej),
      };
      return b;
    });
  }

  /**
   * Like `setupAgentBudget`, but also mocks `agentDailyProposalCap`'s
   * recent-window trust query (D4a: `.select({ status })...orderBy(desc(
   * createdAt)).limit(CAP_TRUST_WINDOW)`, scored the same way as this test's
   * `mockRecentWindow` helper below — most-recent-first rows, the first
   * `windowApproved` of them AUTO_APPROVED, the rest PENDING). Dispatches by
   * the SHAPE of the `.select({...})` field object rather than call order —
   * the real (unmocked) `resolveAgentGovernanceDecision`/`resolveGovernanceRule`
   * run their own `db.select(...)` calls in between, so a call-count-based
   * mock would silently mis-route once that ladder does more than one query.
   */
  function setupWeightedAgentBudget(opts: {
    todayCount: number;
    windowTotal: number;
    windowApproved: number;
    agentMetadata?: Record<string, unknown>;
  }) {
    const {
      todayCount,
      windowTotal,
      windowApproved,
      agentMetadata = { writesRequireProposal: true },
    } = opts;
    const windowRows = Array.from({ length: windowTotal }, (_, i) => ({
      status: i < windowApproved ? "auto_approved" : "pending",
    }));
    mockDbSelect.mockImplementation((fields: Record<string, unknown> = {}) => {
      const keys = Object.keys(fields);
      const isTodayCountQuery = keys.length === 1 && keys[0] === "count";
      const isCapWindowQuery = keys.length === 1 && keys[0] === "status";
      const isAgentRowQuery = keys.includes("userType");
      const isWorkspaceRowQuery = keys.includes("settings");
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        limit: vi
          .fn()
          .mockResolvedValue(
            isAgentRowQuery
              ? [{ userType: "agent", agentMetadata }]
              : isWorkspaceRowQuery
                ? [{ settings: {} }]
                : isCapWindowQuery
                  ? windowRows
                  : []
          ),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const row = isTodayCountQuery ? { count: todayCount } : undefined;
          return Promise.resolve(row ? [row] : []).then(res, rej);
        },
      };
      return b;
    });
  }

  it("refuses the 11th agent proposal in a day (10 already filed → denied)", async () => {
    setupAgentBudget(10);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-runaway-1",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result && result.denied === true).toBe(true);
    expect((result as { reason: string }).reason).toContain(
      "Daily agent proposal limit"
    );
  });

  it("still proposes when under the cap (9 filed → 10th is allowed to propose)", async () => {
    setupAgentBudget(9);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-ok-1",
      subjectType: "entity",
      action: "create",
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("counts per-AGENT, not per-owner: the budget query is scoped to THIS agent's id", async () => {
    setupAgentBudget(0);
    const eqSpy = vi.mocked(mockEq);
    eqSpy.mockClear();

    await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-b",
      subjectType: "entity",
      action: "create",
    });

    // The daily-budget count query (and the trust-weight query) must filter on
    // THIS agent's id — not just the owning human — so a flooding agent A can
    // never eat agent B's separate budget.
    const agentIdArgs = eqSpy.mock.calls.map((c) => c[1]);
    expect(agentIdArgs).toContain("agent-b");
  });

  it("gives a proven agent (>=100 proposals, >=95% approve rate) a 3x (30/day) ceiling", async () => {
    setupWeightedAgentBudget({
      todayCount: 15,
      windowTotal: 100,
      windowApproved: 96,
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-trusted-1",
      subjectType: "entity",
      action: "create",
    });

    // 15 filed today is over the base cap of 10 but under the trusted 30 cap.
    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("keeps the flat 10/day cap for an agent that hasn't earned trust yet (same today-count denied)", async () => {
    setupWeightedAgentBudget({
      todayCount: 15,
      windowTotal: 100,
      windowApproved: 80, // 80% approve rate — below the 95% trust bar
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-untrusted-1",
      subjectType: "entity",
      action: "create",
    });

    expect("denied" in result && result.denied === true).toBe(true);
    expect((result as { reason: string }).reason).toContain(
      "Daily agent proposal limit reached (10/day)"
    );
  });

  it("exempts governance.* meta-proposals from the daily cap entirely", async () => {
    // Budget already exhausted (10 filed today) — a normal proposal would be denied.
    setupAgentBudget(10);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      agentUserId: "agent-governance-1",
      subjectType: "governance",
      action: "governance.widen_lane",
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });
});

describe("checkPermissionOrPropose — legacy AI-sourced path (no agentUserId)", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  function setupWorkspaceSettings(settings: Record<string, unknown>) {
    // Chainable + thenable so the personal-agent attribution lookup
    // (`.orderBy().limit()`) and the agent daily-budget count query
    // (`.select().from().where()` awaited directly → []) both work on the
    // legacy AI-sourced propose path.
    mockDbSelect.mockImplementation(() => {
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        limit: vi.fn().mockResolvedValue([{ settings }]),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve([]).then(res, rej),
      };
      return b;
    });
  }

  it("auto-approves an AI-sourced context.link when the workspace autoApproveFor whitelists context.*", async () => {
    setupWorkspaceSettings({
      aiGovernance: { autoApproveFor: ["context.*"], autoApprove: false },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "context",
      action: "link",
      data: { id: "ctx-1" },
    });

    expect(result).toEqual({ granted: true });
  });

  it("auto-approves an AI-sourced entity.create when the workspace autoApproveFor whitelists entity.create", async () => {
    setupWorkspaceSettings({
      aiGovernance: { autoApproveFor: ["entity.create"], autoApprove: false },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "entity",
      action: "create",
      data: { title: "New contact" },
    });

    expect(result).toEqual({ granted: true });
  });

  it("still proposes an AI-sourced entity.delete even though autoApproveFor whitelists it (destructive floor)", async () => {
    setupWorkspaceSettings({
      aiGovernance: {
        autoApproveFor: ["entity.delete", "entity.*"],
        autoApprove: false,
      },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "entity",
      action: "delete",
      data: { id: "ent-xyz" },
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
  });

  it("proposes an AI-sourced action that is in neither autoApproveFor nor legacy aiAutoApprove", async () => {
    setupWorkspaceSettings({
      aiGovernance: { autoApproveFor: ["search.*"], autoApprove: false },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "view",
      action: "update",
      data: { id: "view-1" },
    });

    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("ONE-STORE (Phase B #1 must-fix): auto-approves an AI-sourced action via a governance_rules row even when the JSONB autoApproveFor does NOT cover it", async () => {
    // The legacy-AI path used to read settings.aiGovernance.autoApproveFor
    // DIRECTLY — a second concurrent store. It must now consult the SAME
    // governance_rules table the agentUserId path's resolver reads. Proof:
    // the JSONB here explicitly does NOT whitelist "view.update" (only
    // "search.*"), yet an active governance_rules row for it still
    // auto-approves — the JSONB is provably NOT what decided this.
    const ruleRow = {
      principalKind: "any",
      scopeKind: "workspace",
      targetKind: "action",
      targetPattern: "view.update",
      targetProfile: null,
      verdict: "auto",
      createdAt: new Date(),
    };
    mockDbSelect.mockImplementation(() => {
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        // Workspace-settings lookup (`.limit(1)` chain).
        limit: vi.fn().mockResolvedValue([
          {
            settings: {
              aiGovernance: {
                autoApproveFor: ["search.*"],
                autoApprove: false,
              },
            },
          },
        ]),
        // governance_rules lookup (`resolveGovernanceRule` — awaited directly,
        // no `.limit()`).
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve([ruleRow]).then(res, rej),
      };
      return b;
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "view",
      action: "update",
      data: { id: "view-1" },
    });

    expect(result).toEqual({ granted: true });
  });

  it("forcePropose always proposes even for a whitelisted AI-sourced action", async () => {
    setupWorkspaceSettings({
      aiGovernance: { autoApproveFor: ["entity.create"], autoApprove: false },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "entity",
      action: "create",
      data: { title: "New contact" },
      forcePropose: true,
    });

    expect("granted" in result && result.granted === false).toBe(true);
  });

  it("preserves legacy behavior: aiAutoApprove=true still auto-approves an action outside the modern whitelist", async () => {
    setupWorkspaceSettings({
      aiGovernance: { autoApprove: true },
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      source: "intelligence",
      subjectType: "view",
      action: "update",
      data: { id: "view-1" },
    });

    expect(result).toEqual({ granted: true });
  });
});

describe("checkPermissionOrPropose — entity-create profile guardrail", () => {
  beforeEach(() => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue({ id: "profile-1", slug: "task" });
    // Reset select mock to the benign default (no agent row) so the guardrail,
    // not the agent branch, is what's under test on the non-agent paths.
    mockDbSelect.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }));
  });

  it("denies an entity create whose profileSlug does not exist, with an actionable reason", async () => {
    mockResolveProfile.mockResolvedValueOnce(null);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      data: { id: "ent-xyz", profileSlug: "partner", title: "Acme" },
    });

    expect(result).toMatchObject({ denied: true });
    const reason = (result as { denied: true; reason: string }).reason;
    expect(reason).toContain("partner");
    expect(reason).toMatch(/does not exist/i);
    expect(reason).toMatch(/list_profiles/);
  });

  it("does NOT deny (resolves) an entity create for an existing profile", async () => {
    mockResolveProfile.mockResolvedValue({ id: "profile-1", slug: "task" });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      data: { id: "ent-xyz", profileSlug: "task", title: "My Task" },
    });

    expect("denied" in result).toBe(false);
    expect(mockResolveProfile).toHaveBeenCalledWith(
      "task",
      BASE_OPTS.userId,
      BASE_OPTS.workspaceId
    );
  });

  it("does NOT fire the guardrail for an entity UPDATE with a bad profileSlug", async () => {
    mockResolveProfile.mockResolvedValue(null);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "update",
      data: { id: "ent-xyz", profileSlug: "partner" },
    });

    // UPDATE targets an existing entity — guardrail is scoped to create only.
    expect("denied" in result).toBe(false);
    expect(mockResolveProfile).not.toHaveBeenCalled();
  });

  it("does NOT fire the guardrail for an entity create WITHOUT a profileSlug", async () => {
    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "create",
      data: { id: "ent-xyz", title: "No profile here" },
    });

    expect("denied" in result).toBe(false);
    expect(mockResolveProfile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: human-proposer branch — an insufficient-role MEMBER proposes rather
// than hard-denying ("team member proposes → owner approves" loop).
// ---------------------------------------------------------------------------

describe("checkPermissionOrPropose — human-proposer (insufficient-role member)", () => {
  /**
   * Sequence mockDbSelect for the human-propose branch: 1st select = workspace
   * settings (policy), 2nd select = workspace_members reviewer probe.
   */
  function setupHumanProposeSelects(
    settings: Record<string, unknown>,
    reviewerRows: Array<{ userId: string }>
  ) {
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      const rows = callCount === 1 ? [{ settings }] : reviewerRows;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(rows),
      } as any;
    });
  }

  beforeEach(() => {
    // A member with an insufficient role (editor attempting an owner-only write).
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "Insufficient workspace permissions (role: editor)",
      role: "editor",
    });
  });

  it("proposes (not denies) and stamps the human as proposer when a reviewer exists", async () => {
    setupHumanProposeSelects({}, [{ userId: "owner-1" }]);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "delete",
      data: { id: "ent-xyz" },
    });

    expect("granted" in result && result.granted === false).toBe(true);
    expect((result as { proposalId: string }).proposalId).toBeDefined();
    // The proposer's userId is recorded on the pending row.
    expect(insertPendingProposal).toHaveBeenCalledWith(
      expect.objectContaining({ proposedByUserId: BASE_OPTS.userId }),
      expect.anything()
    );
  });

  it("denies (does not propose) when the only reviewer candidate is the proposer themselves", async () => {
    // reviewer probe returns only the caller → no OTHER reviewer → hard-deny.
    setupHumanProposeSelects({}, [{ userId: BASE_OPTS.userId }]);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "delete",
      data: { id: "ent-xyz" },
    });

    expect("denied" in result && result.denied === true).toBe(true);
  });

  it("denies a NON-member human (membership miss → no role) — no proposal rights for outsiders", async () => {
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "User is not a member of this workspace",
    });

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "delete",
      data: { id: "ent-xyz" },
    });

    expect("denied" in result && result.denied === true).toBe(true);
  });

  it("denies an insufficient-role member riding an untrusted issuer (deny precedes propose)", async () => {
    setupHumanProposeSelects({}, [{ userId: "owner-1" }]);

    const result = await checkPermissionOrPropose({
      ...BASE_OPTS,
      subjectType: "entity",
      action: "delete",
      data: { id: "ent-xyz" },
      issuer: { kind: "view", trusted: false },
    });

    expect("denied" in result && result.denied === true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: agentDailyProposalCap — direct unit tests (not via checkPermissionOrPropose)
//
// Locks the branch logic in isolation: given the RECENT-WINDOW rows the query
// returns (ordered by createdAt desc, capped at CAP_TRUST_WINDOW — the same
// window agent-scorecard.ts's SCORECARD_SCAN_LIMIT scans), does the trust
// threshold (>=100 in-window, >=95% in-window approve rate) correctly gate the
// 3x (30/day) ceiling vs the flat 10/day base cap.
//
// D4a: this used to score the agent's UNBOUNDED lifetime, which could
// silently disagree with the scorecard's displayed recent-500 approve rate
// (dogfood context: `diagnose type:agent` showed a scorecard approveRate of
// 0.974 sampled over the recent 500 but a dailyCap of 10, not 30 — the two
// numbers looked contradictory to a reviewer). Scoring the SAME window as the
// scorecard makes trust earnable back / lost on recent conduct, and the two
// numbers can no longer visibly disagree.
// ---------------------------------------------------------------------------

describe("agentDailyProposalCap", () => {
  /**
   * Build `total` rows (most-recent-first, matching `orderBy(desc(createdAt))
   * .limit(CAP_TRUST_WINDOW)`) with `approved` of them AUTO_APPROVED and the
   * rest PENDING, then stub the query chain to resolve them.
   */
  function mockRecentWindow(row: { total: number; approved: number }) {
    const rows = Array.from({ length: row.total }, (_, i) => ({
      status: i < row.approved ? "auto_approved" : "pending",
    }));
    mockDbSelect.mockImplementation(() => {
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        limit: vi.fn().mockResolvedValue(rows),
      };
      return b;
    });
  }

  it("gives a proven agent (500 in-window, 487 approved → 97.4%) the 3x (30/day) ceiling", async () => {
    mockRecentWindow({ total: 500, approved: 487 });

    const cap = await agentDailyProposalCap("agent-trusted");

    expect(cap).toBe(30);
  });

  it("keeps the flat 10/day cap when the in-window approve rate is below 95% (500 in-window, 400 approved → 80%)", async () => {
    mockRecentWindow({ total: 500, approved: 400 });

    const cap = await agentDailyProposalCap("agent-untrusted");

    expect(cap).toBe(10);
  });

  it("keeps the flat 10/day cap below the minimum in-window volume even at 100% approval (50 in-window, 50 approved)", async () => {
    mockRecentWindow({ total: 50, approved: 50 });

    const cap = await agentDailyProposalCap("agent-too-new");

    expect(cap).toBe(10);
  });

  it("caps the trust query at the recent window (never scores more than CAP_TRUST_WINDOW rows) — a formerly-trusted agent whose recent conduct regressed loses the 3x ceiling", async () => {
    // Simulates an agent with a huge trustworthy lifetime history, but whose
    // most recent CAP_TRUST_WINDOW rows (what the capped query actually
    // returns) have regressed below the approve-rate threshold. Because the
    // query itself is `.limit(CAP_TRUST_WINDOW)`, only the recent rows are
    // ever visible to this function — the mock returns exactly that shape.
    mockRecentWindow({ total: 500, approved: 450 }); // 90% — below 95%

    const cap = await agentDailyProposalCap("agent-regressed");

    expect(cap).toBe(10);
  });
});
