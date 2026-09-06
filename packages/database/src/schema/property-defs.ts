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
import { relationDefs } from "./relation-defs.js";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * The authored input control for a property.
 *
 * ⚠️ MEASURED, not designed. This union used to declare 8 members
 * (`email · phone · url · person · richtext · datetime · datetime-local ·
 * select`) while `CreatePropertyDefInput.uiHints` was `Record<string, unknown>`
 * — so nothing ever checked it. A census of every literal actually written
 * (2026-09-06) found:
 *
 *   backend src : text 71 · select 33 · textarea 17 · url 13 · number 13 ·
 *                 tags 10 · date 7 · datetime-local 7 · entity-select 7 ·
 *                 checkbox 4 · richtext 3 · email 1 · phone 1
 *   templates   : select 364 · text 343 · textarea 233 · number 142 ·
 *                 date 102 · url 61 · entity 35 · json 12 · checkbox 9 ·
 *                 email 6 · tags 2 · tel 1 · color 1
 *
 * The union was therefore wrong in BOTH directions: `text` — the single most
 * written value, 414 times — was not declared, and `person` / `datetime` are
 * declared but written ZERO times. The list below is the measured reality, so
 * the type finally describes what the database holds.
 *
 * 🚧 NOT yet converged, deliberately. `entity` (35) and `entity-select` (7) are
 * the same intent spelled two ways, as are `tel` (1) and `phone` (1), and
 * reconciling them against the renderer's own `PropertyRenderKind` vocabulary is
 * a separate wave — a blind rename here would mis-map the near-miss tokens. They
 * are recorded as distinct members precisely so the duplication is visible in
 * the type instead of hiding in the data.
 */
export type PropertyInputType =
  // declared before the census, and genuinely written
  | "email"
  | "phone"
  | "url"
  | "richtext"
  | "datetime-local"
  | "select"
  // declared before the census, written NOWHERE (kept: frontend may author them)
  | "person"
  | "datetime"
  // written all along, never declared
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "checkbox"
  | "tags"
  | "json"
  | "color"
  | "entity"
  | "entity-select"
  | "tel";

/** Every member of `PropertyInputType`, for runtime narrowing. */
export const PROPERTY_INPUT_TYPES = [
  "email",
  "phone",
  "url",
  "richtext",
  "datetime-local",
  "select",
  "person",
  "datetime",
  "text",
  "textarea",
  "number",
  "date",
  "checkbox",
  "tags",
  "json",
  "color",
  "entity",
  "entity-select",
  "tel",
] as const satisfies readonly PropertyInputType[];

/**
 * Narrow an AUTHORED `inputType` (template YAML, seed data — both plain
 * strings) to the declared union.
 *
 * Returns `undefined` for an unrecognised spelling rather than storing it: a
 * hint no classifier can read is not a hint, and the classifier's own inference
 * is a better answer than a token it will ignore. `PROPERTY_INPUT_TYPES` was
 * built from a census of every value actually written, so an unrecognised value
 * means a NEW spelling was authored — the caller should log it rather than let
 * it pass silently.
 */
export function asPropertyInputType(
  value: unknown
): PropertyInputType | undefined {
  return typeof value === "string" &&
    (PROPERTY_INPUT_TYPES as readonly string[]).includes(value)
    ? (value as PropertyInputType)
    : undefined;
}

export interface PropertyUIHints {
  displayName?: string;
  /**
   * The AUTHORING twin of `displayName`. Workspace templates and
   * `ensure-system-profiles.ts` write `label`; readers must go
   * through `resolvePropertyLabel` (`displayName ?? label ?? humanized slug`)
   * and never read either key directly.
   *
   * Declared here because it is genuinely written and read — leaving it out of
   * the type while `CreatePropertyDefInput.uiHints` was `Record<string,
   * unknown>` is what let `enumValues`, a key NO reader keys on, be written
   * here for 364 template properties without a single typecheck complaint.
   */
  label?: string;
  placeholder?: string;
  inputType?: PropertyInputType;
  displayAs?: "status" | "priority" | "progress" | "person";
  format?: "locale" | "currency" | "percent" | "compact";
  includeTime?: boolean;
  linkedProfileSlug?: string;
  linkedTable?: "workspace_members" | "free_text";
  itemValueType?:
    "string" | "number" | "boolean" | "date" | "entity_id" | "url";
  pluginHints?: Record<string, unknown>;
  /** Authored helper copy shown under the field. Written by the system seeds. */
  helpText?: string;
  /** Authored long-form description. Written by the system seeds. */
  description?: string;
  /** Authoring-time requiredness hint. The enforced flag is on the LINK row
   *  (`profile_properties.required`); this is the template's declaration of it. */
  required?: boolean;
}

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
    profileId: uuid("profile_id").references(() => profiles.id, {
      onDelete: "cascade",
    }),

    // Workspace scope (Phase 2 — see migration 0065).
    //
    // NULL → "base" def. The property is part of the profile for every
    //        workspace that uses it. All shared/system fields live here.
    // SET  → "overlay" def. The property belongs to that workspace only;
    //        other workspaces using the same profile do NOT render it.
    //        Used when a workspace extends a profile it doesn't own
    //        (e.g. Relay adds `investmentThesis` to the pod-wide `person`).
    //
    // Uniqueness is enforced by three mutually-exclusive partial indexes
    // (see migration 0065):
    //   • (slug) WHERE profile_id IS NULL AND workspace_id IS NULL  — globals
    //   • (slug, profile_id) WHERE workspace_id IS NULL             — base
    //   • (slug, profile_id, workspace_id) WHERE both SET           — overlays
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
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

    uiHints: jsonb("ui_hints").$type<PropertyUIHints>().default({}).notNull(),

    // Unified relations: when valueType is "entity_id" and this is set,
    // writing the property auto-creates a relation row of this type.
    // Clearing the property auto-deletes the corresponding relation.
    relationDefId: uuid("relation_def_id").references(() => relationDefs.id, {
      onDelete: "set null",
    }),

    // Which profile the entity_id should point to (optional constraint).
    // Enables the data structure viewer to draw edges between profiles.
    targetProfileId: uuid("target_profile_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

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
    // Note: the partial unique indexes (global / profile-base / workspace-overlay)
    // are managed in migration 0065 — they can't be expressed in Drizzle directly.
    // Composite lookup index for the hot read path lives there too.
  })
);

export type PropertyDef = typeof propertyDefs.$inferSelect;
export type NewPropertyDef = typeof propertyDefs.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertPropertyDefSchema = createInsertSchema(propertyDefs);
export const selectPropertyDefSchema = createSelectSchema(propertyDefs);
