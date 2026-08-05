import { describe, expect, it } from "vitest";
import { buildSystemMapOverview } from "./system-map.js";

describe("buildSystemMapOverview", () => {
  it("clusters visible kinds and role facets, preserving semantic and structural provenance", () => {
    const overview = buildSystemMapOverview({
      entities: [
        { id: "person-1", type: "person" },
        { id: "person-2", type: "person" },
        { id: "project-1", type: "project" },
      ],
      facetSlugsByEntity: new Map([
        ["person-1", ["customer", "customer", "speaker"]],
        ["person-2", ["customer"]],
      ]),
      semanticRelations: [
        {
          sourceEntityId: "person-1",
          targetEntityId: "project-1",
          type: "contributes_to",
        },
        {
          sourceEntityId: "person-2",
          targetEntityId: "project-1",
          type: "contributes_to",
        },
      ],
      structuralLinks: [
        {
          sourceEntityId: "person-1",
          targetEntityId: "project-1",
          propertySlug: "projectId",
        },
      ],
    });

    expect(overview.kindClusters).toEqual([
      {
        kind: "person",
        count: 2,
        roles: [
          { role: "customer", count: 2 },
          { role: "speaker", count: 1 },
        ],
      },
      { kind: "project", count: 1, roles: [] },
    ]);
    expect(overview.relationBundles).toEqual([
      {
        edgeClass: "semantic",
        type: "contributes_to",
        sourceKind: "person",
        targetKind: "project",
        count: 2,
      },
      {
        edgeClass: "structural",
        type: "projectId",
        sourceKind: "person",
        targetKind: "project",
        count: 1,
      },
    ]);
    expect(overview.totals).toEqual({
      entities: 3,
      semanticRelations: 2,
      structuralLinks: 1,
      relationBundles: 2,
    });
  });

  it("drops edges whose far endpoint is not in the visible node set", () => {
    const overview = buildSystemMapOverview({
      entities: [{ id: "visible", type: "note" }],
      facetSlugsByEntity: new Map(),
      semanticRelations: [
        {
          sourceEntityId: "visible",
          targetEntityId: "hidden",
          type: "mentions",
        },
      ],
      structuralLinks: [
        {
          sourceEntityId: "visible",
          targetEntityId: "hidden",
          propertySlug: "relatedNoteId",
        },
      ],
    });

    expect(overview.relationBundles).toEqual([]);
    expect(overview.totals).toMatchObject({
      entities: 1,
      semanticRelations: 0,
      structuralLinks: 0,
    });
  });
});
