/**
 * Channel Context Items Schema
 *
 * Tracks which objects (entities, documents, views, proposals, inbox items)
 * are referenced or used within a channel.
 *
 * Replaces and merges the old `thread_entities` + `thread_documents` tables
 * into a single polymorphic table that can track any type of object.
 *
 * Key behaviours:
 * - Polymorphic: `objectType` + `objectId` replaces separate entityId/documentId FKs
 * - No direct FK on `objectId` (polymorphic, enforced at application layer)
 * - Unique constraint: (channelId, objectId, objectType, relationshipType)
 * - Conflict tracking preserved for parallel-branch workflows
 * - Cascade-deletes when the parent channel is deleted
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { channels } from "./channels.js";
import { messages } from "./messages.js";

/**
 * The type of object tracked in this context item.
 */
export const ChannelContextObjectType = {
  ENTITY: "entity",
  DOCUMENT: "document",
  VIEW: "view",
  PROPOSAL: "proposal",
  INBOX_ITEM: "inbox_item",
} as const;
export type ChannelContextObjectType =
  (typeof ChannelContextObjectType)[keyof typeof ChannelContextObjectType];

/**
 * How the object relates to the channel.
 */
export const ChannelContextRelationshipType = {
  USED_AS_CONTEXT: "used_as_context",
  CREATED: "created",
  UPDATED: "updated",
  REFERENCED: "referenced",
  INHERITED_FROM_PARENT: "inherited_from_parent",
} as const;
export type ChannelContextRelationshipType =
  (typeof ChannelContextRelationshipType)[keyof typeof ChannelContextRelationshipType];

/**
 * Conflict status (for parallel branch workflows).
 */
export const ChannelContextConflictStatus = {
  NONE: "none",
  PENDING: "pending",
  RESOLVED: "resolved",
} as const;
export type ChannelContextConflictStatus =
  (typeof ChannelContextConflictStatus)[keyof typeof ChannelContextConflictStatus];

export const channelContextItems = pgTable(
  "channel_context_items",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Channel reference
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),

    // Polymorphic object reference (no FK — validated at application layer)
    objectType: text("object_type", {
      enum: [
        ChannelContextObjectType.ENTITY,
        ChannelContextObjectType.DOCUMENT,
        ChannelContextObjectType.VIEW,
        ChannelContextObjectType.PROPOSAL,
        ChannelContextObjectType.INBOX_ITEM,
      ],
    }).notNull(),
    objectId: uuid("object_id").notNull(),

    // Relationship type
    relationshipType: text("relationship_type", {
      enum: [
        ChannelContextRelationshipType.USED_AS_CONTEXT,
        ChannelContextRelationshipType.CREATED,
        ChannelContextRelationshipType.UPDATED,
        ChannelContextRelationshipType.REFERENCED,
        ChannelContextRelationshipType.INHERITED_FROM_PARENT,
      ],
    }).notNull(),

    // Conflict tracking (for parallel-branch workflows)
    conflictStatus: text("conflict_status", {
      enum: [
        ChannelContextConflictStatus.NONE,
        ChannelContextConflictStatus.PENDING,
        ChannelContextConflictStatus.RESOLVED,
      ],
    })
      .notNull()
      .default(ChannelContextConflictStatus.NONE),

    // Source tracking (traceability)
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    // Note: sourceEventId omitted — events is a TimescaleDB hypertable (no FK support)

    // Relevance score set during compaction (0.0–1.0)
    // Used to determine which entities are important enough to include
    // in the entityContextBlock of a compacted state
    relevanceScore: real("relevance_score"),

    // Multi-tenant
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    channelIdIdx: index("channel_context_channel_idx").on(table.channelId),
    objectIdx: index("channel_context_object_idx").on(
      table.objectType,
      table.objectId
    ),
    userIdIdx: index("channel_context_user_idx").on(table.userId),
    workspaceIdIdx: index("channel_context_workspace_idx").on(
      table.workspaceId
    ),
    conflictIdx: index("channel_context_conflict_idx").on(table.conflictStatus),

    // Prevent duplicate relationships (same channel + object + type)
    uniqueContext: unique("channel_context_unique").on(
      table.channelId,
      table.objectId,
      table.objectType,
      table.relationshipType
    ),
  })
);

/** Channel context item row — explicit interface so consumers don't need drizzle-orm. */
export interface ChannelContextItem {
  id: string;
  channelId: string;
  objectType: ChannelContextObjectType;
  objectId: string;
  relationshipType: ChannelContextRelationshipType;
  conflictStatus: ChannelContextConflictStatus;
  sourceMessageId: string | null;
  relevanceScore: number | null;
  userId: string;
  workspaceId: string;
  createdAt: Date;
}
export type NewChannelContextItem = Partial<
  Omit<ChannelContextItem, "id" | "createdAt">
> & {
  channelId: string;
  objectType: ChannelContextObjectType;
  objectId: string;
  relationshipType: ChannelContextRelationshipType;
  userId: string;
  workspaceId: string;
};

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChannelContextItemSchema =
  createInsertSchema(channelContextItems);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChannelContextItemSchema =
  createSelectSchema(channelContextItems);
