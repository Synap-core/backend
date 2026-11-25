/**
 * Entity Links Schema — the dynamic status-propagation graph edges
 *
 * A typed edge between two ENTITY rows. Phase 0 of the dynamic status links
 * plan (decision aa0de6e6, synthesis doc 5b71a257): `link_type =
 * "status-propagates"` means "when the source entity's lifecycle status
 * moves, the target entity's status moves too (same door, governed)".
 *
 * `config` is JSONB and interpretation is deliberately opaque to the table:
 * for `status-propagates` it carries `mapping` (source status → target status);
 * a row without a mapping copies the status across. Other link types are
 * reserved for later phases (blast-radius proposals, live-linked documents).
 *
 * The table is the ONE new table of the phase — relations' `type` column is
 * NOT reused here: `relations` is the knowledge graph for entity DATA and has
 * no cascade FKs, while this table's whole point is a status-move side effect
 * that must survive a re-parenting read and cascade-delete with its ends.
 */

import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { entities } from "./entities.js";

export const entityLinks = pgTable(
  "entity_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull().default("status-propagates"),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sourceIdx: index("entity_links_source_idx").on(table.sourceEntityId),
    targetIdx: index("entity_links_target_idx").on(table.targetEntityId),
    typeIdx: index("entity_links_type_idx").on(table.linkType),
    sourceTargetTypeUnique: uniqueIndex(
      "entity_links_source_target_type_unique"
    ).on(table.sourceEntityId, table.targetEntityId, table.linkType),
  })
);

export type EntityLink = typeof entityLinks.$inferSelect;
export type NewEntityLink = typeof entityLinks.$inferInsert;
