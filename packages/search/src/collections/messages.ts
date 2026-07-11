/**
 * Messages Collection Schema
 *
 * Powers real message-content search within a single channel. `workspaceId` is
 * NOT a column on `messages` — it is JOINED from `channels.workspaceId` at index
 * time (see MessageIndexer / IndexingService.fetchDocuments). Visibility is
 * enforced at query time by the DB channel-access gate; the Typesense filter is
 * pinned to a single `channelId` (see SearchService.buildFilter).
 */

import type { CollectionCreateSchema } from "../types/index.js";

export const messagesCollectionSchema: CollectionCreateSchema = {
  name: "messages",
  fields: [
    // Required fields
    { name: "id", type: "string", facet: false },
    { name: "channelId", type: "string", facet: true, index: true },
    { name: "workspaceId", type: "string", facet: true, index: true },
    { name: "userId", type: "string", facet: true },
    { name: "content", type: "string" },
    { name: "createdAt", type: "int64", index: true },
    { name: "updatedAt", type: "int64", index: true },

    // Optional fields
    { name: "role", type: "string", facet: true, optional: true },
  ],
  default_sorting_field: "updatedAt",
  enable_nested_fields: false,
};
