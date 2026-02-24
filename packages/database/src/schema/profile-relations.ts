/**
 * Profile Relations Junction Table
 *
 * Links profiles to each other via relation definitions.
 * Defines which entity types can connect and through which relation type.
 *
 * Example: contact → company via "works_at" relation def
 */

import {
  pgTable,
  uuid,
  jsonb,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { relationDefs } from "./relation-defs.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const profileRelations = pgTable(
  "profile_relations",
  {
    // Foreign keys (composite primary key)
    sourceProfileId: uuid("source_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    targetProfileId: uuid("target_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    relationDefId: uuid("relation_def_id")
      .notNull()
      .references(() => relationDefs.id, { onDelete: "cascade" }),

    // Display order (for UI)
    displayOrder: integer("display_order").default(0).notNull(),

    // Metadata (JSONB for extensibility)
    // Examples:
    // - { cardinality: "many-to-one" }
    // - { required: true }
    metadata: jsonb("metadata").default("{}").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.sourceProfileId,
        table.targetProfileId,
        table.relationDefId,
      ],
    }),
    sourceProfileIdx: index("profile_relations_source_profile_id_idx").on(
      table.sourceProfileId
    ),
    targetProfileIdx: index("profile_relations_target_profile_id_idx").on(
      table.targetProfileId
    ),
    relationDefIdx: index("profile_relations_relation_def_id_idx").on(
      table.relationDefId
    ),
  })
);

export type ProfileRelation = typeof profileRelations.$inferSelect;
export type NewProfileRelation = typeof profileRelations.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertProfileRelationSchema = createInsertSchema(profileRelations);
export const selectProfileRelationSchema = createSelectSchema(profileRelations);
