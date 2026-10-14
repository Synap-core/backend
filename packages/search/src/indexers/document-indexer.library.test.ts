/**
 * A Library item's search row says so (`libraryItem`, first `libraryGroupId`),
 * and a documents hit carries the typed marker clients route by — so a global
 * search hit opens the item in the Library, not the document editor. Driven
 * through the real indexer → the real hit mapping.
 */
import { describe, it, expect } from "vitest";
import { DocumentIndexer, libraryMarkerOf } from "./document-indexer.js";
import { libraryHitOf } from "../services/search-service.js";
import { documentsCollectionSchema } from "../collections/documents.js";

const base = {
  id: "d1",
  title: "Kept page",
  content: null,
  userId: "u1",
  workspaceId: null,
  type: "text",
  projectId: null,
  createdAt: new Date("2026-10-14T00:00:00Z"),
  updatedAt: new Date("2026-10-14T00:00:00Z"),
};

describe("the Library marker on documents search rows", () => {
  it("a Library item's row is marked, with its first group; a plain doc's is not", async () => {
    const indexer = new DocumentIndexer({} as never);
    const kept = await indexer.toSearchDocument({
      ...base,
      metadata: {
        importItem: { title: "x" },
        importCuration: { groupIds: ["g1", "g2"] },
      },
    });
    expect(kept).toMatchObject({ libraryItem: true, libraryGroupId: "g1" });
    const ungrouped = await indexer.toSearchDocument({
      ...base,
      metadata: { importItem: { title: "x" } },
    });
    expect(ungrouped.libraryItem).toBe(true);
    expect(ungrouped.libraryGroupId).toBeUndefined();
    const plain = await indexer.toSearchDocument({
      ...base,
      metadata: { intakeSource: {} },
    });
    expect(plain.libraryItem).toBeUndefined();

    // The hit clients read carries the typed marker (from the stored row).
    expect(libraryHitOf("documents", kept)).toEqual({
      libraryItem: { groupId: "g1" },
    });
    expect(libraryHitOf("documents", ungrouped)).toEqual({ libraryItem: {} });
    expect(libraryHitOf("documents", plain)).toEqual({});
    expect(libraryHitOf("entities", kept)).toEqual({});
  });

  it("the collection declares both fields as optional (additive on a live collection)", () => {
    const f = Object.fromEntries(
      documentsCollectionSchema.fields!.map((x) => [x.name, x])
    );
    expect(f.libraryItem).toMatchObject({ type: "bool", optional: true });
    expect(f.libraryGroupId).toMatchObject({ type: "string", optional: true });
    expect(libraryMarkerOf(null)).toEqual({});
  });
});
