import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVisibleRelationEndpoints } from "./relations.js";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000099";

type EndpointLookupDb = Parameters<typeof resolveVisibleRelationEndpoints>[0];

const findManyEntities = vi.fn();
const findManyProposals = vi.fn();
const database = {
  query: {
    entities: { findMany: findManyEntities },
    proposals: { findMany: findManyProposals },
  },
} as unknown as EndpointLookupDb;

describe("resolveVisibleRelationEndpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no pending proposal matches the missing endpoint(s).
    findManyProposals.mockResolvedValue([]);
  });

  it("rejects an edge when a private pod-wide endpoint is absent from the caller floor, naming WHICH side without confirming existence", async () => {
    // The query is deliberately modelled as the caller's access-filtered
    // result: SOURCE is visible, TARGET exists but is private to another user.
    findManyEntities.mockResolvedValueOnce([
      { id: SOURCE, workspaceId: WORKSPACE },
    ]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: `One or more relation endpoints are unavailable: target entity ${TARGET} is unavailable (it may not exist, or may not be visible to you)`,
    });

    expect(findManyEntities).toHaveBeenCalledOnce();
    expect(findManyEntities).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { id: true, workspaceId: true },
      })
    );
  });

  it("rejects dangling endpoint ids with the same non-oracular wording (does not distinguish 'missing' from 'private')", async () => {
    findManyEntities.mockResolvedValueOnce([
      { id: SOURCE, workspaceId: WORKSPACE },
    ]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: `One or more relation endpoints are unavailable: target entity ${TARGET} is unavailable (it may not exist, or may not be visible to you)`,
    });
  });

  it("names the caller's own pending proposal when the missing endpoint is a proposedEntityId awaiting approval", async () => {
    findManyEntities.mockResolvedValueOnce([
      { id: SOURCE, workspaceId: WORKSPACE },
    ]);
    findManyProposals.mockResolvedValueOnce([
      { id: PROPOSAL_ID, targetId: TARGET },
    ]);

    await expect(
      resolveVisibleRelationEndpoints(database, "workspace-member", [
        SOURCE,
        TARGET,
      ])
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: `One or more relation endpoints are unavailable: target entity ${TARGET} is not live yet — it is your pending proposal ${PROPOSAL_ID}; approve it first, or create both the entity and this edge in one reviewable call via synap_capture (entities + relations)`,
    });
  });

  it("returns both visible endpoints for relation placement", async () => {
    findManyEntities.mockResolvedValueOnce([
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

    expect(findManyProposals).not.toHaveBeenCalled();
  });
});
