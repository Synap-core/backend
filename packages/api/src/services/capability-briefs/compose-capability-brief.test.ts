/**
 * composeCapabilityBrief — Unit Tests
 *
 * Mocks @synap/database (skills select + ProfileResolutionService) and the
 * `@synap/database/agent-governance` dry-run subpath so these stay fast,
 * deterministic unit tests with no real DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbSelect, mockDryRun, mockGetEffectiveAiPosture } = vi.hoisted(
  () => ({
    mockDbSelect: vi.fn(),
    mockDryRun: vi.fn(),
    mockGetEffectiveAiPosture: vi.fn(),
  })
);

vi.mock("@synap/database", () => ({
  db: { select: mockDbSelect },
  skills: {
    slug: "slug",
    description: "description",
    body: "body",
    teachesTools: "teachesTools",
    alwaysOn: "alwaysOn",
    kind: "kind",
    workspaceId: "workspaceId",
    status: "status",
    approved: "approved",
  },
  ProfileResolutionService: class {
    getEffectiveAiPosture(...args: unknown[]) {
      return mockGetEffectiveAiPosture(...args);
    }
  },
}));

vi.mock("@synap/database/agent-governance", () => ({
  dryRunAgentGovernanceDecision: (...args: unknown[]) => mockDryRun(...args),
}));

import {
  composeCapabilityBrief,
  __resetCapabilityBriefCachesForTest,
} from "./compose-capability-brief.js";

function mockSkillsRows(
  rows: Array<{
    slug: string;
    description: string | null;
    body: string | null;
    teachesTools: string[];
    alwaysOn: boolean;
  }>
) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  });
}

describe("composeCapabilityBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCapabilityBriefCachesForTest();
    mockGetEffectiveAiPosture.mockResolvedValue({});
  });

  it("returns null and never throws when nothing matches and there's no governance/posture", async () => {
    mockSkillsRows([]);
    const brief = await composeCapabilityBrief("synap_ask", {
      workspaceId: null,
      door: "chat",
    });
    expect(brief).toBeNull();
  });

  it("composes teaching + governance + posture + footer for synap_create_document", async () => {
    mockSkillsRows([
      {
        slug: "system/synap/document-embeds",
        description: "Document embed grammar.",
        body: "<!-- brief:start -->\nUse :::synap-entity{id}.\n<!-- brief:end -->\nMore detail here.",
        teachesTools: ["document.create", "create_document"],
        alwaysOn: false,
      },
    ]);
    mockDryRun.mockResolvedValue({
      outcome: "propose",
      rung: "default",
      reason: "No auto-approve rule matched.",
    });
    mockGetEffectiveAiPosture.mockResolvedValue({ openAfterCreate: true });

    const brief = await composeCapabilityBrief("synap_create_document", {
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      door: "chat",
    });

    expect(brief).not.toBeNull();
    expect(brief).toContain("Document embed grammar.");
    expect(brief).toContain('synap_load_skill("system/synap/document-embeds")');
    expect(brief).toContain("Use :::synap-entity{id}.");
    expect(brief).not.toContain("More detail here."); // only the marked extract, not the full body
    expect(brief).toContain("PROPOSAL"); // governance verdict line
    expect(brief).toContain("Open the result for the user after creating it."); // posture
    expect(brief).toContain("surface the result"); // open-affordance footer
  });

  it("skips the governance line when workspaceId/agentUserId are missing", async () => {
    mockSkillsRows([]);
    mockGetEffectiveAiPosture.mockResolvedValue({ openAfterCreate: true });
    const brief = await composeCapabilityBrief("synap_create_document", {
      workspaceId: null,
      door: "chat",
    });
    expect(mockDryRun).not.toHaveBeenCalled();
    // No teaching, no governance, but posture (document: openAfterCreate) still applies.
    expect(brief).toContain("Open the result");
  });

  it("never throws — a DB failure resolves to null", async () => {
    mockDbSelect.mockImplementation(() => {
      throw new Error("boom");
    });
    const brief = await composeCapabilityBrief("synap_create_document", {
      workspaceId: "ws-1",
      agentUserId: "agent-1",
      door: "chat",
    });
    expect(brief).toBeNull();
  });
});
