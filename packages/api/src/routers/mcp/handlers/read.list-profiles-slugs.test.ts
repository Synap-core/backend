/**
 * synap_list_profiles `slugs` — forwarded to the Hub `profileSlugs` filter
 * (ticket 1531fbeb). The tool took no slug filter, so asking for one kind
 * returned every kind.
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

const run = (args: Record<string, unknown>) =>
  readHandlers.synap_list_profiles!({
    toolName: "synap_list_profiles",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      profiles: { listProfiles },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  });

beforeEach(() => {
  vi.clearAllMocks();
  getUserMemberWorkspaceIds.mockResolvedValue(["ws-a", "ws-b"]);
  listProfiles.mockResolvedValue({ profiles: [] });
});

describe("synap_list_profiles slugs", () => {
  it("forwards `slugs` as profileSlugs on a workspace lens", async () => {
    await run({ workspaceId: "ws-a", slugs: ["deal", "task"] });
    expect(listProfiles.mock.calls[0]![0]).toMatchObject({
      workspaceId: "ws-a",
      profileSlugs: ["deal", "task"],
    });
  });

  it("forwards `slugs` to every workspace read of the pod-wide list", async () => {
    await run({ slugs: ["deal"] });
    expect(listProfiles).toHaveBeenCalledTimes(2);
    for (const call of listProfiles.mock.calls) {
      expect(call[0]).toMatchObject({ profileSlugs: ["deal"] });
    }
  });

  it("sends no filter when `slugs` is absent or empty", async () => {
    await run({ slugs: [] });
    expect(listProfiles.mock.calls[0]![0]).not.toHaveProperty("profileSlugs");
  });
});
