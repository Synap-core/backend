/**
 * An entity's summary is its `preview` column (the row has no `description`).
 * The indexer reads it into the search doc's `description` field, which the
 * entities query searches (ticket 75134529: a note was found only by its title).
 */
import { describe, it, expect } from "vitest";
import { EntityIndexer } from "./entity-indexer.js";

const row = {
  id: "e1",
  title: "Governance, proposals and permissions",
  content: null,
  preview:
    "One engine decideAgentPolicy, one call site, governance_rules rung 2.8",
  userId: "u1",
  workspaceId: "ws-1",
  projectId: null,
  type: "note",
  tags: null,
  status: null,
  properties: null,
  createdAt: new Date("2026-10-21T00:00:00Z"),
  updatedAt: new Date("2026-10-21T00:00:00Z"),
};

describe("entity search doc: the summary is indexed", () => {
  it("indexes the entity's preview as `description`", async () => {
    const doc = await new EntityIndexer().toSearchDocument(row);
    expect(doc.description).toBe(row.preview);
  });

  it("an entity with no preview has no description (never an empty string)", async () => {
    const doc = await new EntityIndexer().toSearchDocument({
      ...row,
      preview: null,
    });
    expect(doc.description).toBeUndefined();
  });
});
