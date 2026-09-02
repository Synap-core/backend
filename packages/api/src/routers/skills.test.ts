/**
 * skills.ts — insertSkillGoverned unit tests
 *
 * Covers the governance fix (D4, CAPABILITY-MARKETPLACE-PLAN.md Wave 1): every
 * skill-creation door (`create`, `installFromUrl`, Hub Protocol
 * `/agent-skills/import`) must persist through this ONE governed insert path —
 * never a direct `db.insert(skills)` with a hardcoded `approved: true`.
 *
 * Heavy I/O (DB insert, checkPermissionOrPropose, auditLog, emitSideEffects) is
 * mocked so this stays a fast, deterministic unit test — mirrors the mocking
 * style in `utils/permission-check.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheckPermissionOrPropose, mockDbInsert, mockInsertedRow } =
  vi.hoisted(() => ({
    mockCheckPermissionOrPropose: vi.fn(),
    mockDbInsert: vi.fn(),
    mockInsertedRow: { current: null as Record<string, unknown> | null },
  }));

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermissionOrPropose,
  createPendingProposal: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: {
    insert: mockDbInsert,
  },
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...conds) => ({ and: conds })),
  or: vi.fn((...conds) => ({ or: conds })),
  desc: vi.fn((col) => ({ desc: col })),
  inArray: vi.fn((col, arr) => ({ inArray: [col, arr] })),
}));

vi.mock("@synap/database/schema", () => ({
  skills: { id: "id", name: "name", kind: "kind" },
  tools: {},
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(),
}));

// Modules skills.ts imports but this test never exercises — stub so the
// module graph resolves without pulling in real DB/network/tRPC wiring.
vi.mock("../services/links/links-service.js", () => ({
  getLinksFor: vi.fn(),
  createLinks: vi.fn(),
  deleteLink: vi.fn(),
}));
vi.mock("../utils/user-scoped.js", () => ({
  requireUserId: vi.fn((id: string) => id),
}));
vi.mock("../utils/user-visible-where.js", () => ({
  userVisibleWhere: vi.fn(),
}));
vi.mock("@synap/shared-utils", () => ({ safeExternalFetch: vi.fn() }));
vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: vi.fn(),
}));
vi.mock("../utils/workspace-role.js", () => ({
  getWorkspaceRole: vi.fn(),
  requirePodAdmin: vi.fn(),
}));
vi.mock("../skills/skill-md-parser.js", () => ({ parseSkillMd: vi.fn() }));
vi.mock("../skills/skill-toml-parser.js", () => ({ parseSkillToml: vi.fn() }));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(),
}));
vi.mock("../trpc.js", () => ({
  router: (routes: unknown) => routes,
  protectedProcedure: {
    input: () => ({ query: vi.fn(), mutation: vi.fn() }),
  },
}));

import { insertSkillGoverned, skillExecFieldsChanged } from "./skills.js";

/**
 * The re-approval demotion must fire on CHANGE, not on presence. The
 * standalone-config reconcile's three-way merge re-sends every baseline key
 * whenever any one field drifts, so a presence test un-approved a
 * market-installed skill on every reconcile pass — it stopped being runnable.
 */
describe("skillExecFieldsChanged", () => {
  const existing = {
    kind: "declarative",
    code: null,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    providerSpec: { baseUrl: "https://api.example.com", method: "GET" },
    executionMode: "sync",
    timeoutSeconds: 30,
  };

  it("is FALSE when the reconcile replays execution fields byte-identically", () => {
    expect(
      skillExecFieldsChanged(
        {
          description: "typo fixed upstream",
          parameters: existing.parameters,
          providerSpec: existing.providerSpec,
          code: null,
          kind: "declarative",
          executionMode: "sync",
          timeoutSeconds: 30,
        },
        existing
      )
    ).toBe(false);
  });

  it("ignores jsonb key order — a re-serialized providerSpec is not a change", () => {
    expect(
      skillExecFieldsChanged(
        { providerSpec: { method: "GET", baseUrl: "https://api.example.com" } },
        existing
      )
    ).toBe(false);
  });

  it("is TRUE when a declarative skill is re-pointed at another endpoint", () => {
    expect(
      skillExecFieldsChanged(
        {
          providerSpec: { baseUrl: "https://evil.example.com", method: "GET" },
        },
        existing
      )
    ).toBe(true);
  });

  it("is TRUE for a real change to any other execution-defining field", () => {
    expect(skillExecFieldsChanged({ code: "console.log(1)" }, existing)).toBe(
      true
    );
    expect(skillExecFieldsChanged({ kind: "code" }, existing)).toBe(true);
    expect(skillExecFieldsChanged({ timeoutSeconds: 60 }, existing)).toBe(true);
    expect(skillExecFieldsChanged({ executionMode: "async" }, existing)).toBe(
      true
    );
    expect(
      skillExecFieldsChanged({ parameters: { type: "object" } }, existing)
    ).toBe(true);
  });
});

describe("insertSkillGoverned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbInsert.mockImplementation(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        mockInsertedRow.current = v;
        return {
          returning: vi.fn().mockResolvedValue([v]),
        };
      }),
    }));
  });

  it("operator install of an instruction skill lands approved (no agentUserId)", async () => {
    mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });

    const result = await insertSkillGoverned({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "instruction",
      name: "some-skill",
      body: "do the thing",
      auditSource: "install_from_url",
    } as never);

    expect(result.status).toBe("installed");
    expect(mockInsertedRow.current?.approved).toBe(true);
  });

  it("agent-initiated instruction install is born UNAPPROVED even when governance grants the write", async () => {
    mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });

    const result = await insertSkillGoverned({
      userId: "human-owner",
      agentUserId: "agent-1",
      workspaceId: null,
      kind: "instruction",
      name: "remote-skill",
      body: "remote instructions",
      auditSource: "agent_skills_import",
    } as never);

    expect(result.status).toBe("installed");
    expect(mockInsertedRow.current?.approved).toBe(false);
  });

  it("routes to a proposal instead of inserting when governance defers", async () => {
    mockCheckPermissionOrPropose.mockResolvedValue({
      proposalId: "proposal-123",
    });

    const result = await insertSkillGoverned({
      userId: "human-owner",
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      kind: "instruction",
      name: "gated-skill",
      body: "gated instructions",
      auditSource: "agent_skills_import",
    } as never);

    expect(result).toEqual({ status: "proposed", proposalId: "proposal-123" });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("propagates a denial without inserting", async () => {
    mockCheckPermissionOrPropose.mockResolvedValue({
      denied: true,
      reason: "Permission denied",
    });

    const result = await insertSkillGoverned({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "instruction",
      name: "denied-skill",
      body: "nope",
      auditSource: "install_from_url",
    } as never);

    expect(result).toEqual({
      status: "denied",
      reason: "Permission denied",
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("never approves an executable (code) skill, even for an operator", async () => {
    mockCheckPermissionOrPropose.mockResolvedValue({ granted: true });

    const result = await insertSkillGoverned({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "code",
      name: "code-skill",
      code: "console.log(1)",
      auditSource: "install_from_url",
    } as never);

    expect(result.status).toBe("installed");
    expect(mockInsertedRow.current?.approved).toBe(false);
  });
});
