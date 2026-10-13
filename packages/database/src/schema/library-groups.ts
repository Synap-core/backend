/**
 * Library groups — the person's persistent groups over their Library
 * (CAPTURE_LIBRARY_PLAN L2, migration 0326).
 *
 * The Library is a lens over every staged item (`documents.metadata ? 'importItem'`)
 * across import runs. A group persists past any one run: it keeps its note,
 * its outputs, the collection entity Build minted (`container_entity_id`, which
 * a rebuild updates instead of twinning) and its built state. Item membership
 * stays on the item (`documents.metadata.importCuration.groupIds`).
 *
 * A group is NOT an entity before Build on purpose: entity writes fire
 * automations, embeddings and indexing.
 *
 * Owner-floored: every read and write is `user_id = caller`
 * (`access/registry.ts`, rule `user`).
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const LIBRARY_GROUP_ORIGINS = ["ai", "user", "rule"] as const;
export type LibraryGroupOrigin = (typeof LIBRARY_GROUP_ORIGINS)[number];

export const libraryGroups = pgTable(
  "library_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** A lens tag (where Build files); NULL = pod-wide. */
    workspaceId: uuid("workspace_id"),
    /** Stable slug-like key, unique per person. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    note: text("note"),
    origin: text("origin")
      .$type<LibraryGroupOrigin>()
      .notNull()
      .default("user"),
    /** `ImportGroupOutput[]` — what Build should propose. */
    outputs: jsonb("outputs").$type<string[]>().notNull().default([]),
    /** The collection entity Build minted or reused; rebuilds update it. */
    containerEntityId: uuid("container_entity_id"),
    buildingAt: timestamp("building_at", { mode: "date", withTimezone: true }),
    builtAt: timestamp("built_at", { mode: "date", withTimezone: true }),
    /** Every bundle proposal Build filed for this group, oldest first. */
    buildProposalIds: jsonb("build_proposal_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userKeyUnique: uniqueIndex("library_groups_user_key_unique").on(
      table.userId,
      table.key
    ),
    userLiveIdx: index("library_groups_user_live_idx")
      .on(table.userId, table.updatedAt)
      .where(sql`archived_at IS NULL`),
  })
);

export type LibraryGroupRow = typeof libraryGroups.$inferSelect;
export type NewLibraryGroupRow = typeof libraryGroups.$inferInsert;
