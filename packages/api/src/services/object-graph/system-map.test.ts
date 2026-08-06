import { describe, expect, it } from "vitest";
import {
  buildSystemMapEntityGraph,
  buildSystemMapOverview,
} from "./system-map.js";

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

  it("builds a bounded raw force graph with exact page total and provenance", () => {
    const graph = buildSystemMapEntityGraph({
      entities: [
        {
          id: "person-1",
          type: "person",
          title: "Ada",
          preview: "Engineer",
          workspaceId: "workspace-1",
        },
        {
          id: "project-1",
          type: "project",
          title: "Compiler",
          preview: null,
          workspaceId: "workspace-1",
        },
      ],
      facetSlugsByEntity: new Map([["person-1", ["customer", "customer"]]]),
      semanticRelations: [
        {
          sourceEntityId: "person-1",
          targetEntityId: "project-1",
          type: "contributes_to",
        },
        {
          sourceEntityId: "person-1",
          targetEntityId: "not-on-this-page",
          type: "mentions",
        },
      ],
      structuralLinks: [
        {
          sourceEntityId: "person-1",
          targetEntityId: "project-1",
          propertySlug: "projectId",
        },
      ],
      total: 3,
      limit: 2,
      offset: 0,
      semanticRelationsTotal: 1,
      structuralLinksTotal: 1,
    });

    expect(graph.nodes).toEqual([
      {
        id: "person-1",
        type: "person",
        title: "Ada",
        preview: "Engineer",
        workspaceId: "workspace-1",
        facetSlugs: ["customer"],
      },
      {
        id: "project-1",
        type: "project",
        title: "Compiler",
        preview: null,
        workspaceId: "workspace-1",
        facetSlugs: [],
      },
    ]);
    expect(graph.edges).toEqual([
      {
        edgeClass: "semantic",
        sourceEntityId: "person-1",
        targetEntityId: "project-1",
        type: "contributes_to",
      },
      {
        edgeClass: "structural",
        sourceEntityId: "person-1",
        targetEntityId: "project-1",
        propertySlug: "projectId",
      },
    ]);
    expect(graph).toMatchObject({
      total: 3,
      totals: {
        returnedEntities: 2,
        semanticRelations: 1,
        structuralLinks: 1,
        edges: 2,
        returnedSemanticRelations: 1,
        returnedStructuralLinks: 1,
        returnedEdges: 2,
      },
      pagination: { limit: 2, offset: 0, hasMore: true },
      complete: false,
      truncationReason: "node_limit",
    });
  });

  it("declares an edge-capped graph incomplete while preserving exact edge totals", () => {
    const graph = buildSystemMapEntityGraph({
      entities: [
        {
          id: "note-1",
          type: "note",
          title: null,
          preview: null,
          workspaceId: null,
        },
        {
          id: "note-2",
          type: "note",
          title: null,
          preview: null,
          workspaceId: null,
        },
      ],
      facetSlugsByEntity: new Map(),
      semanticRelations: [
        {
          sourceEntityId: "note-1",
          targetEntityId: "note-2",
          type: "mentions",
        },
      ],
      structuralLinks: [],
      total: 2,
      limit: 2,
      offset: 0,
      semanticRelationsTotal: 2,
      structuralLinksTotal: 0,
    });

    expect(graph).toMatchObject({
      totals: { semanticRelations: 2, returnedSemanticRelations: 1 },
      complete: false,
      truncationReason: "edge_limit",
    });
  });
});
