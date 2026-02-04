/**
 * Entity Property Index Schema
 *
 * Optional performance table for fast filtering/sorting/searching.
 * This is a projection/index, NOT the source of truth.
 * Source of truth is entities.properties JSONB column.
 *
 * Only indexes properties that are marked as "indexed" in the profile.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { propertyDefs } from "./property-defs.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const entityPropertyIndex = pgTable(
  "entity_property_index",
  {
    // Foreign keys (composite primary key)
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    propertyDefId: uuid("property_def_id")
      .notNull()
      .references(() => propertyDefs.id, { onDelete: "cascade" }),

    // Typed value columns (one will be populated based on property value_type)
    valueText: text("value_text"), // For string, entity_id (as text)
    valueNum: numeric("value_num"), // For number
    valueBool: boolean("value_bool"), // For boolean
    valueTs: timestamp("value_ts", { mode: "date", withTimezone: true }), // For date
    valueEntityId: uuid("value_entity_id"), // For entity_id (as UUID)
    valueJsonb: jsonb("value_jsonb"), // For array, object
  },
  (table) => ({
    pk: primaryKey({ columns: [table.entityId, table.propertyDefId] }),
    // Indexes for fast queries (one per value type)
    propertyValueTextIdx: index(
      "entity_property_index_property_value_text_idx"
    ).on(table.propertyDefId, table.valueText),
    propertyValueNumIdx: index(
      "entity_property_index_property_value_num_idx"
    ).on(table.propertyDefId, table.valueNum),
    propertyValueBoolIdx: index(
      "entity_property_index_property_value_bool_idx"
    ).on(table.propertyDefId, table.valueBool),
    propertyValueTsIdx: index("entity_property_index_property_value_ts_idx").on(
      table.propertyDefId,
      table.valueTs
    ),
    propertyValueEntityIdx: index(
      "entity_property_index_property_value_entity_idx"
    ).on(table.propertyDefId, table.valueEntityId),
    // Entity lookup (get all properties for an entity)
    entityIdx: index("entity_property_index_entity_id_idx").on(table.entityId),
  })
);

export type EntityPropertyIndex = typeof entityPropertyIndex.$inferSelect;
export type NewEntityPropertyIndex = typeof entityPropertyIndex.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertEntityPropertyIndexSchema =
  createInsertSchema(entityPropertyIndex);
export const selectEntityPropertyIndexSchema =
  createSelectSchema(entityPropertyIndex);
