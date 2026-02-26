/**
 * Property Definitions Schema
 *
 * Defines reusable property definitions that can be attached to profiles.
 * Properties are the building blocks of entity metadata schemas.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { profiles } from "./profiles.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * Property Value Types
 */
export enum PropertyValueType {
  STRING = "string",
  NUMBER = "number",
  BOOLEAN = "boolean",
  DATE = "date",
  /**
   * A UUID reference to another entity in the same workspace.
   *
   * This is a STRUCTURAL LINK — part of the profile schema, not the graph.
   * When a property has this type, the value stored is the UUID of another entity.
   * It represents a modelled, schema-defined relationship (e.g. "this task's project",
   * "this deal's primary contact").
   *
   * These differ from semantic graph relations (`relations` table):
   * - Structural links (entity_id props) are schema-defined, form-based, one-directional
   * - Semantic relations are schema-free, emergent, bi-directional
   *
   * Use `entity_property_index.value_entity_id` for fast reverse-lookup:
   * "find all entities whose [property] points to entity X"
   *
   * @see /docs/docs/concepts/entity-connections.md — architecture decision doc
   */
  ENTITY_ID = "entity_id",
  ARRAY = "array",
  OBJECT = "object",
  SECRET = "secret",
}

export const propertyDefs = pgTable(
  "property_defs",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Property identity (unique slug)
    slug: text("slug").notNull(),

    // Profile scope — null means global/system def; non-null means profile-scoped def.
    // Unique constraint: (slug, profile_id) per profile, (slug) for global defs.
    profileId: uuid("profile_id").references(() => profiles.id, {
      onDelete: "cascade",
    }),

    // Value type
    valueType: text("value_type", {
      enum: [
        PropertyValueType.STRING,
        PropertyValueType.NUMBER,
        PropertyValueType.BOOLEAN,
        PropertyValueType.DATE,
        PropertyValueType.ENTITY_ID,
        PropertyValueType.ARRAY,
        PropertyValueType.OBJECT,
        PropertyValueType.SECRET,
      ],
    }).notNull(),

    // Constraints (JSONB)
    // Examples:
    // - { min: 0, max: 100 } for numbers
    // - { enum: ["low", "medium", "high"] } for string enums
    // - { format: "email" | "uri" | "date-time" } for string formats
    // - { pattern: "^[a-z]+$" } for regex patterns
    constraints: jsonb("constraints").default("{}").notNull(),

    // UI hints (JSONB)
    // Examples:
    // - { label: "Due Date", icon: "calendar", placeholder: "Select date" }
    // - { helpText: "Priority level for this task" }
    // - { inputType: "date" | "select" | "textarea" }
    uiHints: jsonb("ui_hints").default("{}").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    valueTypeIdx: index("property_defs_value_type_idx").on(table.valueType),
    profileIdIdx: index("property_defs_profile_id_idx").on(table.profileId),
    // Note: unique constraints for (slug, profile_id) and global (slug WHERE profile_id IS NULL)
    // are managed via partial unique indexes in migration 0039 (not expressible in Drizzle directly).
  })
);

export type PropertyDef = typeof propertyDefs.$inferSelect;
export type NewPropertyDef = typeof propertyDefs.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertPropertyDefSchema = createInsertSchema(propertyDefs);
export const selectPropertyDefSchema = createSelectSchema(propertyDefs);
