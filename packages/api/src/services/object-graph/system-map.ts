/**
 * System Map aggregate — a deliberately small, server-side projection of the
 * entity graph for overview surfaces. The router owns the scoped reads; this
 * module owns only the deterministic folding of already-visible rows.
 *
 * Keeping the fold pure makes the visibility invariant explicit: a bundle is
 * emitted only when BOTH endpoint entities are present in the visible node set.
 * An edge is never itself a permission grant.
 */

export interface SystemMapEntity {
  id: string;
  type: string;
}

export interface SystemMapSemanticRelation {
  sourceEntityId: string | null;
  targetEntityId: string | null;
  type: string;
}

export interface SystemMapStructuralLink {
  sourceEntityId: string;
  targetEntityId: string | null;
  propertySlug: string;
}

export interface SystemMapKindCluster {
  kind: string;
  count: number;
  /** Live, visible role facets attached to entities of this kind. */
  roles: Array<{ role: string; count: number }>;
}

export interface SystemMapRelationBundle {
  /** Emergent relations table edge, or schema-defined entity_id property. */
  edgeClass: "semantic" | "structural";
  /** Relation type for semantic edges; property slug for structural links. */
  type: string;
  sourceKind: string;
  targetKind: string;
  count: number;
}

export interface SystemMapOverview {
  kindClusters: SystemMapKindCluster[];
  relationBundles: SystemMapRelationBundle[];
  totals: {
    entities: number;
    semanticRelations: number;
    structuralLinks: number;
    relationBundles: number;
  };
}

/** A concrete entity node for the bounded force-graph view. */
export interface SystemMapEntityGraphNode extends SystemMapEntity {
  title: string | null;
  preview: string | null;
  workspaceId: string | null;
  /** Live role slugs already filtered through the caller's facet lens. */
  facetSlugs: string[];
}

/** A raw, visible relation row between two returned force-graph nodes. */
export interface SystemMapEntityGraphSemanticEdge {
  edgeClass: "semantic";
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
}

/** A raw indexed entity_id-property link between two returned nodes. */
export interface SystemMapEntityGraphStructuralEdge {
  edgeClass: "structural";
  sourceEntityId: string;
  targetEntityId: string;
  propertySlug: string;
}

export type SystemMapEntityGraphEdge =
  SystemMapEntityGraphSemanticEdge | SystemMapEntityGraphStructuralEdge;

export interface SystemMapEntityGraph {
  nodes: SystemMapEntityGraphNode[];
  /** Individual edges, never kind-level aggregates. */
  edges: SystemMapEntityGraphEdge[];
  /** Exact number of entities matching the scoped filter, before the cap. */
  total: number;
  totals: {
    returnedEntities: number;
    /** Exact edge totals for the returned node set, before each edge cap. */
    semanticRelations: number;
    structuralLinks: number;
    edges: number;
    returnedSemanticRelations: number;
    returnedStructuralLinks: number;
    returnedEdges: number;
  };
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  /** False whenever node paging, edge caps, or a nonzero offset omits graph data. */
  complete: boolean;
  truncationReason: "node_limit" | "edge_limit" | "offset" | null;
}

export interface BuildSystemMapOverviewInput {
  entities: SystemMapEntity[];
  /** Must have been loaded through the same visibility lens as entities. */
  facetSlugsByEntity: ReadonlyMap<string, readonly string[]>;
  semanticRelations: SystemMapSemanticRelation[];
  structuralLinks: SystemMapStructuralLink[];
}

export interface BuildSystemMapEntityGraphInput {
  entities: Array<
    SystemMapEntity & {
      title: string | null;
      preview: string | null;
      workspaceId: string | null;
    }
  >;
  facetSlugsByEntity: ReadonlyMap<string, readonly string[]>;
  semanticRelations: SystemMapSemanticRelation[];
  structuralLinks: SystemMapStructuralLink[];
  total: number;
  limit: number;
  offset: number;
  semanticRelationsTotal: number;
  structuralLinksTotal: number;
}

interface MutableBundle extends SystemMapRelationBundle {}

function compareCounts<T extends { count: number }>(a: T, b: T): number {
  return b.count - a.count;
}

/**
 * Fold a visibility-scoped entity graph into the compact System Map contract.
 * This intentionally does not accept raw database rows: callers must establish
 * the access floor before the aggregate exists.
 */
export function buildSystemMapOverview(
  input: BuildSystemMapOverviewInput
): SystemMapOverview {
  const entityKinds = new Map<string, string>();
  const clusterCounts = new Map<string, number>();
  const roleCountsByKind = new Map<string, Map<string, number>>();

  for (const entity of input.entities) {
    entityKinds.set(entity.id, entity.type);
    clusterCounts.set(entity.type, (clusterCounts.get(entity.type) ?? 0) + 1);

    // A role can be attached in more than one context. A cluster answers
    // "entities wearing this role", so each entity contributes at most once.
    const roles = new Set(input.facetSlugsByEntity.get(entity.id) ?? []);
    if (roles.size === 0) continue;
    let roleCounts = roleCountsByKind.get(entity.type);
    if (!roleCounts) {
      roleCounts = new Map<string, number>();
      roleCountsByKind.set(entity.type, roleCounts);
    }
    for (const role of roles) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }

  const bundles = new Map<string, MutableBundle>();
  const addBundle = (
    edgeClass: SystemMapRelationBundle["edgeClass"],
    type: string,
    sourceEntityId: string | null,
    targetEntityId: string | null
  ) => {
    if (!sourceEntityId || !targetEntityId) return;
    const sourceKind = entityKinds.get(sourceEntityId);
    const targetKind = entityKinds.get(targetEntityId);
    // Do not generate dangling (and potentially revealing) aggregate edges.
    if (!sourceKind || !targetKind) return;
    const key = `${edgeClass}\u0000${type}\u0000${sourceKind}\u0000${targetKind}`;
    const existing = bundles.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    bundles.set(key, { edgeClass, type, sourceKind, targetKind, count: 1 });
  };

  for (const relation of input.semanticRelations) {
    addBundle(
      "semantic",
      relation.type,
      relation.sourceEntityId,
      relation.targetEntityId
    );
  }
  for (const link of input.structuralLinks) {
    addBundle(
      "structural",
      link.propertySlug,
      link.sourceEntityId,
      link.targetEntityId
    );
  }

  const kindClusters = [...clusterCounts.entries()]
    .map(([kind, count]) => ({
      kind,
      count,
      roles: [...(roleCountsByKind.get(kind) ?? new Map()).entries()]
        .map(([role, roleCount]) => ({ role, count: roleCount }))
        .sort((a, b) => compareCounts(a, b) || a.role.localeCompare(b.role)),
    }))
    .sort((a, b) => compareCounts(a, b) || a.kind.localeCompare(b.kind));

  const relationBundles = [...bundles.values()].sort(
    (a, b) =>
      compareCounts(a, b) ||
      a.edgeClass.localeCompare(b.edgeClass) ||
      a.type.localeCompare(b.type) ||
      a.sourceKind.localeCompare(b.sourceKind) ||
      a.targetKind.localeCompare(b.targetKind)
  );

  return {
    kindClusters,
    relationBundles,
    totals: {
      entities: input.entities.length,
      semanticRelations: input.semanticRelations.filter(
        (relation) =>
          relation.sourceEntityId !== null &&
          relation.targetEntityId !== null &&
          entityKinds.has(relation.sourceEntityId) &&
          entityKinds.has(relation.targetEntityId)
      ).length,
      structuralLinks: input.structuralLinks.filter(
        (link) =>
          link.targetEntityId !== null &&
          entityKinds.has(link.sourceEntityId) &&
          entityKinds.has(link.targetEntityId)
      ).length,
      relationBundles: relationBundles.length,
    },
  };
}

/**
 * Fold one bounded, already-visible System Map node page into the force-graph
 * contract. As with the overview, only edges with both returned endpoints are
 * emitted: an edge never discloses a node outside the caller's page/lens.
 */
export function buildSystemMapEntityGraph(
  input: BuildSystemMapEntityGraphInput
): SystemMapEntityGraph {
  const nodeIds = new Set(input.entities.map((entity) => entity.id));
  const nodes = input.entities.map((entity) => ({
    ...entity,
    facetSlugs: [...new Set(input.facetSlugsByEntity.get(entity.id) ?? [])],
  }));
  const semanticEdges: SystemMapEntityGraphSemanticEdge[] = [];
  const structuralEdges: SystemMapEntityGraphStructuralEdge[] = [];

  for (const relation of input.semanticRelations) {
    if (
      relation.sourceEntityId === null ||
      relation.targetEntityId === null ||
      !nodeIds.has(relation.sourceEntityId) ||
      !nodeIds.has(relation.targetEntityId)
    ) {
      continue;
    }
    semanticEdges.push({
      edgeClass: "semantic",
      sourceEntityId: relation.sourceEntityId,
      targetEntityId: relation.targetEntityId,
      type: relation.type,
    });
  }

  for (const link of input.structuralLinks) {
    if (
      link.targetEntityId === null ||
      !nodeIds.has(link.sourceEntityId) ||
      !nodeIds.has(link.targetEntityId)
    ) {
      continue;
    }
    structuralEdges.push({
      edgeClass: "structural",
      sourceEntityId: link.sourceEntityId,
      targetEntityId: link.targetEntityId,
      propertySlug: link.propertySlug,
    });
  }

  const edges: SystemMapEntityGraphEdge[] = [
    ...semanticEdges,
    ...structuralEdges,
  ];
  const hasMore = input.offset + nodes.length < input.total;
  const returnedEdges = edges.length;
  const totalEdges = input.semanticRelationsTotal + input.structuralLinksTotal;
  const truncationReason = hasMore
    ? "node_limit"
    : input.offset > 0
      ? "offset"
      : returnedEdges < totalEdges
        ? "edge_limit"
        : null;

  return {
    nodes,
    edges,
    total: input.total,
    totals: {
      returnedEntities: nodes.length,
      semanticRelations: input.semanticRelationsTotal,
      structuralLinks: input.structuralLinksTotal,
      edges: totalEdges,
      returnedSemanticRelations: semanticEdges.length,
      returnedStructuralLinks: structuralEdges.length,
      returnedEdges,
    },
    pagination: {
      limit: input.limit,
      offset: input.offset,
      hasMore,
    },
    complete: truncationReason === null,
    truncationReason,
  };
}
