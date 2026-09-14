/**
 * A runnable-action verbId (what GET /capabilities/actions and Raycast
 * list-actions hand out) must resolve to a brief. Live 2026-09-14 every verbId
 * returned `{}`: briefs were keyed only by MCP `synap_*` names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbSelect, mockGetEffectiveAiPosture } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockGetEffectiveAiPosture: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: { select: mockDbSelect },
  skills: {
    slug: "slug",
    description: "description",
    body: "body",
    teachesTools: "teachesTools",
    alwaysOn: "alwaysOn",
    kind: "kind",
    workspaceId: "workspaceId",
  },
  ProfileResolutionService: class {
    getEffectiveAiPosture(...args: unknown[]) {
      return mockGetEffectiveAiPosture(...args);
    }
  },
}));

vi.mock("@synap/database/agent-governance", () => ({
  dryRunAgentGovernanceDecision: vi.fn(),
}));

import {
  composeCapabilityBrief,
  resolveTeachingAliases,
  __resetCapabilityBriefCachesForTest,
} from "./compose-capability-brief.js";

describe("composeCapabilityBrief — action verbIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCapabilityBriefCachesForTest();
    mockGetEffectiveAiPosture.mockResolvedValue({});
    // Teaches only the MCP-side key `create_entity` — reachable from the verb
    // `entity.create` ONLY through the alias map.
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          slug: "system/synap/writes",
          description: "Entity writes guide",
          body: null,
          teachesTools: ["create_entity"],
          alwaysOn: false,
        },
      ]),
    });
  });

  it("resolves a verbId to the MCP tools that teach it, by the existing alias map", () => {
    expect(resolveTeachingAliases("entity.create")).toContain(
      "synap_create_entity"
    );
    expect(resolveTeachingAliases("synap_create_entity")).toEqual([]);
    expect(resolveTeachingAliases("no.such_verb")).toEqual([]);
  });

  it("entity.create picks up the alias tool's teaching", async () => {
    const brief = await composeCapabilityBrief("entity.create", {
      door: "chat",
    });
    expect(brief).toContain("Entity writes guide");
  });

  it("entity.query resolves by verbId with its run posture", async () => {
    const brief = await composeCapabilityBrief("entity.query", {
      door: "chat",
      workspaceId: "ws-1",
      actionPosture: "auto",
    });
    expect(brief).toContain("runs directly");
    const write = await composeCapabilityBrief("entity.delete", {
      door: "chat",
      workspaceId: "ws-1",
      actionPosture: "propose",
    });
    expect(write).toContain("PROPOSAL");
  });

  it("a miss stays a miss (null → omitted → found:false downstream)", async () => {
    expect(
      await composeCapabilityBrief("no.such_verb", { door: "chat" })
    ).toBeNull();
  });
});
