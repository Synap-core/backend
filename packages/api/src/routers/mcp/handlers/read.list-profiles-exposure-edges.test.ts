/**
 * synap_list_profiles — exposure edges are not advertised (ticket 2ef2fbeb, #14).
 *
 * `belongs_to_project` (and `visible_to`) resolve in the relation vocabulary,
 * but `synap_link_entities` / `relations.create` REFUSE them: each has its own
 * writer (`synap_file_into_project` for a project). The list's own contract is
 * "a slug listed here is a slug a write accepts", so an agent that read it and
 * linked an entity to a project hit a refusal for a slug this tool handed it.
 *
 * Drives the REAL handler over a stubbed vocabulary read; both the digest and
 * the `detail:'full'` shapes are asserted.
 */
import { describe, it, expect, vi } from "vitest";

const { listProfiles } = vi.hoisted(() => ({ listProfiles: vi.fn() }));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds: vi.fn(async () => []),
}));

vi.mock("../../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/relation-types.js")
  >()),
  listEffectiveRelationTypes: vi.fn(async () =>
    ["belongs_to_project", "visible_to", "related_to", "works_at"].map(
      (slug) => ({
        slug,
        displayName: slug,
        description: null,
        isDirectional: true,
        inverseLabel: null,
        workspaceId: null,
      })
    )
  ),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

async function call(args: Record<string, unknown>) {
  const result = await readHandlers.synap_list_profiles!({
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
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as {
    relationTypes: Array<{ slug?: string; slugs?: string[] }>;
  };
}

describe("synap_list_profiles — exposure edges are not listed", () => {
  it("digest: the slugs a write accepts, without belongs_to_project / visible_to", async () => {
    const { relationTypes } = await call({});
    const slugs = relationTypes.flatMap((g) => g.slugs ?? []);
    // Non-vacuity: the stubbed vocabulary did reach the answer.
    expect(slugs).toEqual(["related_to", "works_at"]);
  });

  it("full: the same filter on full relation-type rows", async () => {
    const { relationTypes } = await call({ detail: "full" });
    expect(relationTypes.map((r) => r.slug)).toEqual([
      "related_to",
      "works_at",
    ]);
  });
});
