/**
 * synap_get_relations — workspace resolution (A1 regression).
 *
 * When the caller gives no `workspaceId`, relations must be read from the
 * ENTITY'S OWN workspace, not an arbitrary member workspace (`ids[0]`, which
 * is unordered Postgres natural order). When the entity has no workspace (a
 * pod-wide entity, or a deleted / missing one) the handler reads at the
 * caller's USER FLOOR (`listRelationsPodWide`), never a picked member
 * workspace: the pod-wide entity's edges live in several spaces.
 *
 * `db.query.entities.findFirst` and `getUserMemberWorkspaceIds` are mocked so
 * this exercises the handler's own branching, not the DB or the tRPC caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  findFirst,
  getUserMemberWorkspaceIds,
  listRelations,
  listRelationsPodWide,
} = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getUserMemberWorkspaceIds: vi.fn(),
  listRelations: vi.fn(),
  listRelationsPodWide: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      entities: { findFirst },
    },
  },
}));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds,
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    toolName: "synap_get_relations",
    args: { entityId: "entity-1" },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      relations: { listRelations, listRelationsPodWide },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
    ...overrides,
  };
}

describe("synap_get_relations — workspace resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRelations.mockResolvedValue([]);
    listRelationsPodWide.mockResolvedValue({ entities: [], configLinks: [] });
  });

  it("scopes to the entity's OWN workspace when none is given (not ids[0])", async () => {
    findFirst.mockResolvedValue({ workspaceId: "ws-entity-home" });
    // If it fell back to the arbitrary pick, this would be consulted — it must not be.
    getUserMemberWorkspaceIds.mockResolvedValue(["ws-other-1", "ws-other-2"]);

    const result = await readHandlers.synap_get_relations!(makeCtx());

    expect(listRelations).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-entity-home" })
    );
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    const block = result.content?.[0];
    if (!block || block.type !== "text") throw new Error("expected text");
    const payload = JSON.parse(block.text) as Record<string, unknown>;
    // Byte-identical shape (no honesty note injected) — deterministic resolution.
    expect(payload.note).toBeUndefined();
  });

  it("reads at the USER FLOOR, never a picked member workspace, when the entity has no workspace", async () => {
    findFirst.mockResolvedValue({ workspaceId: null }); // a pod-wide entity
    getUserMemberWorkspaceIds.mockResolvedValue(["ws-a", "ws-b", "ws-c"]);

    const result = await readHandlers.synap_get_relations!(makeCtx());

    expect(listRelationsPodWide).toHaveBeenCalledWith({
      userId: "user-1",
      entityId: "entity-1",
    });
    expect(listRelations).not.toHaveBeenCalled();
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    const block = result.content?.[0];
    if (!block || block.type !== "text") throw new Error("expected text");
    const payload = JSON.parse(block.text) as Record<string, unknown>;
    expect(payload.note).toBeUndefined();
    expect(payload.scopedWorkspaceId).toBeUndefined();
  });

  it("still honors an explicit workspaceId untouched (byte-identical common case)", async () => {
    const result = await readHandlers.synap_get_relations!(
      makeCtx({ args: { entityId: "entity-1", workspaceId: "ws-explicit" } })
    );

    expect(findFirst).not.toHaveBeenCalled();
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    expect(listRelationsPodWide).not.toHaveBeenCalled();
    expect(listRelations).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-explicit" })
    );
    const block = result.content?.[0];
    if (!block || block.type !== "text") throw new Error("expected text");
    const payload = JSON.parse(block.text) as Record<string, unknown>;
    expect(payload.note).toBeUndefined();
  });
});
