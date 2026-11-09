/**
 * synap_list_profiles pages: the founder's pod has ~145 kinds (39,416 chars as
 * a digest, measured 2026-11-09), over the 16,000-char reply cap, and the cap
 * cut the JSON mid-row. A default call is now one page (40) with
 * total/offset/nextOffset, and the relation vocabulary rides the FIRST page
 * only. Walked to the end: every profile once.
 */
import { describe, it, expect, vi } from "vitest";

const { getUserMemberWorkspaceIds, listProfiles } = vi.hoisted(() => ({
  getUserMemberWorkspaceIds: vi.fn(async () => ["ws-a"]),
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
  listEffectiveRelationTypes: vi.fn(async () => [
    { slug: "relates_to", workspaceId: null },
  ]),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

const PROFILES = Array.from({ length: 100 }, (_, i) => ({
  id: `p${i}`,
  slug: `kind-${String(i).padStart(3, "0")}`,
  displayName: `Kind ${i}`,
}));

async function page(args: Record<string, unknown>) {
  listProfiles.mockResolvedValue({ profiles: PROFILES });
  const res = await readHandlers.synap_list_profiles!({
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
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    any
  >;
}

describe("synap_list_profiles pages", () => {
  it("a default call is one page of 40 with total and nextOffset, and the vocabulary", async () => {
    const body = await page({});
    expect(body.profiles).toHaveLength(40);
    expect(body).toMatchObject({ total: 100, offset: 0, nextOffset: 40 });
    expect(body).toHaveProperty("relationTypes");
  });

  it("later pages carry no relationTypes; the last has no nextOffset; the union is every kind once", async () => {
    const slugs: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const body = await page({ offset });
      if (offset > 0) expect(body).not.toHaveProperty("relationTypes");
      slugs.push(...body.profiles.map((p: { slug: string }) => p.slug));
      offset = body.nextOffset;
    }
    expect(slugs).toEqual(PROFILES.map((p) => p.slug));
  });

  it("limit and a workspaceId lens page the same way", async () => {
    const body = await page({ workspaceId: "ws-a", limit: 10, offset: 95 });
    expect(body.profiles).toHaveLength(5);
    expect(body).not.toHaveProperty("nextOffset");
  });
});
