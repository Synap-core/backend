/**
 * Views Collection Schema
 */

import type { CollectionCreateSchema } from "typesense/lib/Typesense/Collections";

export const viewsCollectionSchema: CollectionCreateSchema = {
  name: "views",
  fields: [
    // Required fields
    { name: "id", type: "string", facet: false },
    { name: "name", type: "string" },
    { name: "userId", type: "string", facet: true, index: true },
    { name: "workspaceId", type: "string", facet: true, index: true },
    { name: "createdAt", type: "int64", index: true },
    { name: "updatedAt", type: "int64", index: true },

    // Optional fields
    { name: "description", type: "string", optional: true },
    { name: "viewType", type: "string", facet: true, optional: true },
    { name: "projectId", type: "string", facet: true, optional: true },

    // Ranking signals
    { name: "viewCount", type: "int32", optional: true },
    { name: "lastAccessedAt", type: "int64", optional: true },
  ],
  default_sorting_field: "updatedAt",
  enable_nested_fields: false,
};
