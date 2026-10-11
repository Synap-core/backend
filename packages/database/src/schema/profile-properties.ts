/**
 * Profile Properties Junction Table
 *
 * Links profiles to property definitions.
 * Defines which properties are available for each profile, with requirements and defaults.
 */

import {
  pgTable,
  uuid,
  boolean,
  jsonb,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { profiles } from "./profiles.js";
import { propertyDefs } from "./property-defs.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const profileProperties = pgTable(
  "profile_properties",
  {
    // Foreign keys (composite primary key)
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    propertyDefId: uuid("property_def_id")
      .notNull()
      .references(() => propertyDefs.id, { onDelete: "cascade" }),

    // Property configuration
    required: boolean("required").default(false).notNull(),
    defaultValue: jsonb("default_value"), // Default value for this property in this profile

    // Display order (for UI)
    displayOrder: integer("display_order").default(0).notNull(),

    // LIFECYCLE (0319, W12): this property IS the profile's lifecycle. At most
    // one per profile — `profile_properties_one_lifecycle_uniq` (partial unique
    // on profile_id WHERE is_lifecycle). Its options live on the def at
    // `constraints.enumOptions` (`utils/property-enum.ts`, the one mapper).
    isLifecycle: boolean("is_lifecycle").default(false).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.propertyDefId] }),
    profileIdx: index("profile_properties_profile_id_idx").on(table.profileId),
    propertyDefIdx: index("profile_properties_property_def_id_idx").on(
      table.propertyDefId
    ),
    oneLifecycleUniq: uniqueIndex("profile_properties_one_lifecycle_uniq")
      .on(table.profileId)
      .where(sql`${table.isLifecycle}`),
  })
);

export type ProfileProperty = typeof profileProperties.$inferSelect;
export type NewProfileProperty = typeof profileProperties.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertProfilePropertySchema =
  createInsertSchema(profileProperties);
export const selectProfilePropertySchema =
  createSelectSchema(profileProperties);
