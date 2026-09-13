/**
 * synap_list_profiles — multi-workspace branch (C7).
 *
 * A workspace whose profile read FAILS must be named in `workspacesFailed`,
 * never folded into "that workspace has no profiles" (its kinds silently
 * missing from the answer). The other workspaces' profiles still return.
 *
 * Also pins the stability floor: workspace ids are read in sorted order, so
 * the first-wins dedupe picks the same row whatever order membership returns.
 * (Which twin SHOULD win is a pending ontology decision — not asserted here
 * beyond "stable".)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMemberWorkspaceIds, listProfiles } = vi.hoisted(() => ({
  getUserMemberWorkspaceIds: vi.fn(),
  listProfiles: vi.fn(),
}));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds,
}));

vi.mock("../../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/relation-types.js")
  >()),
  listEffectiveRelationTypes: vi.fn(async () => []),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

function makeCtx(): McpToolContext {
  return {
    toolName: "synap_list_profiles",
    args: {},
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      profiles: { listProfiles },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  };
}

function payloadOf(
  result: Awaited<
    ReturnType<NonNullable<typeof readHandlers.synap_list_profiles>>
  >
) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as {
    profiles: Array<{ slug: string; workspaceId?: string }>;
    workspacesFailed?: Array<{ workspaceId: string; error: string }>;
  };
}

describe("synap_list_profiles — multi-workspace failures + stable order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProfiles.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === "ws-c") throw new Error("profiles read timed out");
        if (workspaceId === "ws-a") return { profiles: [{ slug: "task" }] };
        return { profiles: [{ slug: "task" }, { slug: "deal" }] };
      }
    );
  });

  it("names the failed workspace and still returns the others' profiles", async () => {
    getUserMemberWorkspaceIds.mockResolvedValue(["ws-b", "ws-c", "ws-a"]);
    const payload = payloadOf(
      await readHandlers.synap_list_profiles!(makeCtx())
    );

    expect(payload.workspacesFailed).toEqual([
      { workspaceId: "ws-c", error: "profiles read timed out" },
    ]);
    expect(payload.profiles.map((p) => p.slug).sort()).toEqual([
      "deal",
      "task",
    ]);
  });

  it("the first-wins row does not depend on membership order", async () => {
    for (const order of [
      ["ws-b", "ws-a"],
      ["ws-a", "ws-b"],
    ]) {
      getUserMemberWorkspaceIds.mockResolvedValue(order);
      const payload = payloadOf(
        await readHandlers.synap_list_profiles!(makeCtx())
      );
      expect(payload.profiles.find((p) => p.slug === "task")?.workspaceId).toBe(
        "ws-a"
      );
      expect(payload.workspacesFailed).toBeUndefined();
    }
  });
});
