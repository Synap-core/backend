/**
 * Which collections a pod must reindex: those whose stamped index version is
 * below the indexer's. A pod that never stamped (every pod before this) is
 * behind on every versioned collection.
 */
import { describe, it, expect } from "vitest";
import { SEARCH_INDEX_VERSIONS, collectionsBehind } from "./index-version.js";

describe("collectionsBehind", () => {
  it("a pod with no stamp reindexes every versioned collection", () => {
    expect(collectionsBehind(undefined).sort()).toEqual(
      Object.keys(SEARCH_INDEX_VERSIONS).sort()
    );
    expect(collectionsBehind({})).toContain("entities");
  });

  it("entities are behind until stamped at the version that indexes the summary", () => {
    expect(SEARCH_INDEX_VERSIONS.entities).toBeGreaterThanOrEqual(2);
    expect(collectionsBehind({ entities: 1, documents: 1 })).toEqual([
      "entities",
    ]);
  });

  it("documents are versioned: a pod that only reindexed entities still holds owned bodies", () => {
    expect(SEARCH_INDEX_VERSIONS.documents).toBeGreaterThanOrEqual(1);
    expect(collectionsBehind({ entities: 2 })).toEqual(["documents"]);
  });

  it("a pod stamped at the current versions has nothing to reindex", () => {
    expect(collectionsBehind({ ...SEARCH_INDEX_VERSIONS })).toEqual([]);
  });
});
