/**
 * Chat Threads Collection Schema
 */

import type { CollectionCreateSchema } from "typesense/lib/Typesense/Collections";

export const chatThreadsCollectionSchema: CollectionCreateSchema = {
  name: "chat_threads",
  fields: [
    // Required fields
    { name: "id", type: "string", facet: false },
    { name: "title", type: "string" },
    { name: "userId", type: "string", facet: true, index: true },
    { name: "workspaceId", type: "string", facet: true, index: true },
    { name: "createdAt", type: "int64", index: true },
    { name: "updatedAt", type: "int64", index: true },

    // Optional fields
    { name: "summary", type: "string", optional: true },
    { name: "messageCount", type: "int32", optional: true },

    // Ranking signals
    { name: "lastAccessedAt", type: "int64", optional: true },
  ],
  default_sorting_field: "updatedAt",
  enable_nested_fields: false,
};
