/**
 * Entities Collection Schema
 */

import type { CollectionCreateSchema } from "../types/index.js";

export const entitiesCollectionSchema: CollectionCreateSchema = {
  name: "entities",
  fields: [
    // Required fields
    { name: "id", type: "string", facet: false },
    { name: "title", type: "string" },
    { name: "userId", type: "string", facet: true, index: true },
    { name: "workspaceId", type: "string", facet: true, index: true },
    { name: "createdAt", type: "int64", index: true },
    { name: "updatedAt", type: "int64", index: true },

    // Optional fields
    { name: "content", type: "string", optional: true },
    { name: "description", type: "string", optional: true },
    { name: "entityType", type: "string", facet: true, optional: true },
    // Kind+Facets: role-profile slugs attached to the entity (Wave 3B). Additive
    // field — CollectionService.reconcileNewFields adds it to existing pods.
    { name: "facetSlugs", type: "string[]", facet: true, optional: true },
    // Visibility parity (search/DB floor): the workspace ids that grant a NON-OWNER
    // read of this entity via membership OR role-as-lens — the entity's own
    // `workspaceId` (when non-null) ∪ the workspace ids of its ACTIVE (non-deleted)
    // facets. Populated by EntityIndexer.toSearchDocument from the facet workspaces
    // threaded through IndexingService. The query-time entity floor admits
    // `visibleInWorkspaces:=[<caller's member workspaces>]` so a shared entity is
    // found in Cmd-K / recall, mirroring the DB `accessScopeWhere` floor. Additive
    // field — CollectionService.reconcileNewFields adds it to existing pods; a
    // one-time fullReindex("entities") backfills it on deploy.
    {
      name: "visibleInWorkspaces",
      type: "string[]",
      facet: true,
      optional: true,
    },
    { name: "projectId", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "status", type: "string", facet: true, optional: true },
    // Identity handles/aliases (email, discord-handle, aliases[]) flattened for
    // keyword search — so searching a handle finds the person. Populated by
    // EntityIndexer.toSearchDocument.
    { name: "searchAliases", type: "string[]", facet: false, optional: true },

    // Ranking signals
    { name: "viewCount", type: "int32", optional: true },
    { name: "lastAccessedAt", type: "int64", optional: true },
  ],
  default_sorting_field: "updatedAt",
  enable_nested_fields: false,
};
