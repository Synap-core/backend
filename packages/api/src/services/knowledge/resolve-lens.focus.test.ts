/**
 * resolveKnowledgeLens resolves the calling agent's declared focus ONCE, as a
 * BOOST (structural plan S1, decision 756c740f). The caller's explicit scope
 * stays the filter; the focus never becomes `workspaceId`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const VISIBLE = ["ws-a", "ws-b"];
const focus = vi.hoisted(() => ({
  workspaceId: null as string | null,
  projectId: null as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: async () => ({}),
  ProfileRepository: class {
    getAccessibleProfiles = async () => [];
  },
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  validateWorkspaceAccess: async (_u: string, requested: string[]) =>
    requested.filter((id) => VISIBLE.includes(id)),
}));
vi.mock("../agent-identity-service.js", () => ({
  getAgentFocusWorkspaceId: async () => focus.workspaceId,
  getAgentFocusProjectId: async () => focus.projectId,
}));

const { resolveKnowledgeLens } = await import("./resolve-lens.js");

beforeEach(() => {
  focus.workspaceId = null;
  focus.projectId = null;
});

describe("resolveKnowledgeLens — the agent's focus is a boost", () => {
  it("an agent's declared focus becomes the boost, never the filter", async () => {
    focus.workspaceId = "ws-a";
    focus.projectId = "project-1";
    const lens = await resolveKnowledgeLens("u", undefined, {
      agentUserId: "agent",
    });
    expect(lens.workspaceId).toBeNull(); // still pod-wide
    expect(lens.focus).toEqual({
      workspaceId: "ws-a",
      projectId: "project-1",
      source: "agent_focus",
    });
  });

  it("a person (no agent) has no focus", async () => {
    focus.workspaceId = "ws-a";
    const lens = await resolveKnowledgeLens("u", undefined);
    expect(lens.focus).toBeNull();
  });

  it("an explicit scope stays the filter; the axis it covers is not boosted again", async () => {
    focus.workspaceId = "ws-a";
    focus.projectId = "project-1";
    const lens = await resolveKnowledgeLens("u", "ws-a", {
      projectId: "project-1",
      agentUserId: "agent",
    });
    expect(lens.workspaceId).toBe("ws-a");
    expect(lens.focus).toBeNull();
  });

  it("a focus on another axis than the filter still boosts", async () => {
    focus.workspaceId = "ws-b";
    const lens = await resolveKnowledgeLens("u", "ws-a", {
      agentUserId: "agent",
    });
    expect(lens.workspaceId).toBe("ws-a");
    expect(lens.focus).toEqual({
      workspaceId: "ws-b",
      projectId: null,
      source: "agent_focus",
    });
  });

  it("a focus workspace the caller cannot see is dropped, never honoured", async () => {
    focus.workspaceId = "ws-foreign";
    const lens = await resolveKnowledgeLens("u", undefined, {
      agentUserId: "agent",
    });
    expect(lens.focus).toBeNull();
  });
});
