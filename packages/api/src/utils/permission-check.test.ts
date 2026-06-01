/**
 * permission-check.ts — Unit Tests
 *
 * Covers the pure-logic gates that were added/changed:
 *   - CBAC: capability allowlist enforcement
 *   - writesRequireProposal: assistant-template write gate
 *   - ADMIN_ACTIONS: always-propose regardless of whitelist / writesRequireProposal flag
 *   - buildProposalSummary: label composition helper
 *   - STUDIO_APP_URL: env override
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
const { mockVerifyPermission, mockDbSelect, mockDbInsert } = vi.hoisted(() => ({
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
}));

vi.mock("@synap/database", async () => {
  const { randomUUID } = await import("crypto");
  mockDbInsert.mockImplementation(() => ({
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
    catch: vi.fn().mockReturnThis(),
  }));
  mockDbSelect.mockImplementation(() => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  }));
  return {
    db: { insert: mockDbInsert, select: mockDbSelect, transaction: vi.fn() },
    proposals: {},
    entities: {},
    users: { id: "id", userType: "userType", agentMetadata: "agentMetadata" },
    workspaces: { id: "id", settings: "settings" },
    eq: vi.fn((a, b) => ({ field: a, value: b })),
    verifyPermission: mockVerifyPermission,
    ProposalStatus: { PENDING: "pending", AUTO_APPROVED: "auto_approved" },
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
  STUDIO_APP_URL,
} from "./permission-check.js";

// We also need checkPermissionOrPropose for the integration-style unit tests.
// Import it separately so mocks are fully resolved first.
import { checkPermissionOrPropose } from "./permission-check.js";

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
  mockDbSelect.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValue([{ userType: "agent", agentMetadata }]),
      } as any;
    }
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ settings: workspaceSettings }]),
    } as any;
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
    expect(result.reviewPath).toBe("/proposals/prop-001");
    expect(result.reviewUrl).toContain("/proposals/prop-001");
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
