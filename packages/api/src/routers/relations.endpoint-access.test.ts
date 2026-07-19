import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVisibleRelationEndpoints } from "./relations.js";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-000000000010";

type EndpointLookupDb = Parameters<typeof resolveVisibleRelationEndpoints>[0];

const findMany = vi.fn();
const database = {
  query: { entities: { findMany } },
} as unknown as EndpointLookupDb;

describe("resolveVisibleRelationEndpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an edge when a private pod-wide endpoint is absent from the caller floor", async () => {
    // The query is deliberately modelled as the caller's access-filtered
    // result: SOURCE is visible, TARGET exists but is private to another user.
    findMany.mockResolvedValueOnce([{ id: SOURCE, workspaceId: WORKSPACE }]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "One or more relation endpoints are unavailable.",
    });

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { id: true, workspaceId: true },
      })
    );
  });

  it("rejects dangling endpoint ids with the same non-oracular response", async () => {
    findMany.mockResolvedValueOnce([{ id: SOURCE, workspaceId: WORKSPACE }]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "One or more relation endpoints are unavailable.",
    });
  });

  it("returns both visible endpoints for relation placement", async () => {
    findMany.mockResolvedValueOnce([
      { id: SOURCE, workspaceId: WORKSPACE },
      { id: TARGET, workspaceId: null },
    ]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).resolves.toEqual([
      { id: SOURCE, workspaceId: WORKSPACE },
      { id: TARGET, workspaceId: null },
    ]);
  });
});
