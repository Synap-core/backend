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
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * Property Value Types
 */
export enum PropertyValueType {
  STRING = "string",
  NUMBER = "number",
  BOOLEAN = "boolean",
  DATE = "date",
  ENTITY_ID = "entity_id",
  ARRAY = "array",
  OBJECT = "object",
}

export const propertyDefs = pgTable(
  "property_defs",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Property identity (unique slug)
    slug: text("slug").notNull(),

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
    slugUnique: unique("property_defs_slug_unique_idx").on(table.slug),
    valueTypeIdx: index("property_defs_value_type_idx").on(table.valueType),
  })
);

export type PropertyDef = typeof propertyDefs.$inferSelect;
export type NewPropertyDef = typeof propertyDefs.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertPropertyDefSchema = createInsertSchema(propertyDefs);
export const selectPropertyDefSchema = createSelectSchema(propertyDefs);
