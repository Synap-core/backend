/**
 * The dependency edge read back as a relation row, and the ONE neighbourhood
 * read-state rule. Each row says which candidate rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  dependencyLinkAsRelationRow,
  deriveNodeNeighbourhood,
  nodeNeighbourhoodState,
  normaliseDependencyRelation,
} from "./index.js";

const link = (over: Record<string, unknown> = {}) => ({
  id: "L1",
  fromType: "entity",
  fromId: "A",
  toType: "entity",
  toId: "B",
  linkType: "blocked_by",
  workspaceId: "W",
  metadata: {},
  createdBy: "u",
  createdAt: "2026-10-05T00:00:00Z",
  ...over,
});

describe("dependencyLinkAsRelationRow", () => {
  it("a link-door edge reads as depends_on, blocked → blocker (rules out 'always blocks')", () => {
    const row = dependencyLinkAsRelationRow(link())!;
    expect(row).toMatchObject({
      id: "L1",
      storedAs: "link",
      type: "depends_on",
      sourceEntityId: "A",
      targetEntityId: "B",
      legacyRelationId: null,
    });
  });

  it("a `blocks` edge reads back in the direction it was drawn (rules out 'ignore relationType')", () => {
    // A --blocks--> B was stored as B --blocked_by--> A.
    const stored = normaliseDependencyRelation("blocks", "A", "B")!;
    const row = dependencyLinkAsRelationRow(
      link({
        fromId: stored.fromId,
        toId: stored.toId,
        metadata: { relationType: "blocks", migratedFromRelationId: "R9" },
      })
    )!;
    expect(row.type).toBe("blocks");
    expect(row.sourceEntityId).toBe("A");
    expect(row.targetEntityId).toBe("B");
    expect(row.legacyRelationId).toBe("R9");
  });

  it("round-trips depends_on (rules out a swapped inverse)", () => {
    const stored = normaliseDependencyRelation("depends_on", "A", "B")!;
    const row = dependencyLinkAsRelationRow(
      link({
        fromId: stored.fromId,
        toId: stored.toId,
        metadata: { relationType: "depends_on" },
      })
    )!;
    expect([row.sourceEntityId, row.targetEntityId]).toEqual(["A", "B"]);
  });

  it("is not a relation unless entity ↔ entity blocked_by (rules out 'every link')", () => {
    expect(
      dependencyLinkAsRelationRow(link({ fromType: "session" }))
    ).toBeNull();
    expect(
      dependencyLinkAsRelationRow(link({ linkType: "replaces" }))
    ).toBeNull();
  });
});

describe("nodeNeighbourhoodState", () => {
  const q = (
    o: Partial<{
      isError: boolean;
      isLoading: boolean;
      hasData: boolean;
      errorCode: string;
    }>
  ) => ({
    isError: false,
    isLoading: false,
    hasData: true,
    ...o,
  });
  it("NOT_FOUND is missing, not ready-empty (rules out relay's old fold)", () => {
    expect(
      nodeNeighbourhoodState({
        query: q({ isError: true, hasData: false, errorCode: "NOT_FOUND" }),
        vocab: { pending: false },
      })
    ).toBe("missing");
  });
  it("any other error is failed (rules out 'every error is missing')", () => {
    expect(
      nodeNeighbourhoodState({
        query: q({
          isError: true,
          hasData: false,
          errorCode: "INTERNAL_SERVER_ERROR",
        }),
        vocab: { pending: false },
      })
    ).toBe("failed");
  });
  it("waits for the vocabulary (rules out browser's old 'ready without vocab')", () => {
    expect(
      nodeNeighbourhoodState({ query: q({}), vocab: { pending: true } })
    ).toBe("loading");
  });
  it("loading until data; ready once both land", () => {
    expect(
      nodeNeighbourhoodState({
        query: q({ isLoading: true, hasData: false }),
        vocab: { pending: false },
      })
    ).toBe("loading");
    expect(
      nodeNeighbourhoodState({ query: q({}), vocab: { pending: false } })
    ).toBe("ready");
  });
});

describe("a hidden far end (M1)", () => {
  it("reads as 'Hidden blocker' in Blocked by, with no status or mark (rules out 'name it by its id')", () => {
    const n = deriveNodeNeighbourhood(
      { kind: "entity", id: "F", status: "todo", title: "Focus" },
      [
        {
          id: "X",
          name: "X",
          kind: "entity",
          edgeType: "blocked_by",
          direction: "outgoing",
          via: "links",
          status: "done",
          hidden: true,
        },
      ]
    );
    const [item] = n.blockedBy.items;
    expect(item.title).toBe("Hidden blocker");
    expect(item.hidden).toBe(true);
    expect(item.status).toBeNull();
    expect(item.state).toBeNull();
  });
});
