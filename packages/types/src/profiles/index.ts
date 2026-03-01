/**
 * Profile System Types
 *
 * Types for the dynamic profile-based entity type system.
 * Profiles define entity types as configuration, not code.
 */

import { z } from "zod";

/**
 * Profile Scope
 * Determines who can access and use a profile
 */
export type ProfileScope = "system" | "workspace" | "user" | "shared";

/**
 * Property Value Types
 * Supported types for entity properties
 */
export type PropertyValueType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "entity_id"
  | "array"
  | "object"
  | "secret";

/**
 * Profile Schema
 */
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  parentProfileId: z.string().uuid().nullable(),
  uiHints: z.record(z.string(), z.unknown()),
  /** Default property values applied when creating a new entity of this type. */
  defaultValues: z.record(z.string(), z.unknown()).default({}),
  scope: z.enum(["system", "workspace", "user", "shared"]),
  userId: z.string().nullable(),
  workspaceId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Property Definition Schema
 */
export const PropertyDefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  valueType: z.enum([
    "string",
    "number",
    "boolean",
    "date",
    "entity_id",
    "array",
    "object",
    "secret",
  ]),
  constraints: z.record(z.string(), z.unknown()),
  uiHints: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type PropertyDef = z.infer<typeof PropertyDefSchema>;

/**
 * Profile Property Link Schema
 * Links a property definition to a profile with configuration
 */
export const ProfilePropertySchema = z.object({
  profileId: z.string().uuid(),
  propertyDefId: z.string().uuid(),
  required: z.boolean(),
  defaultValue: z.unknown().nullable(),
  displayOrder: z.number(),
});

export type ProfileProperty = z.infer<typeof ProfilePropertySchema>;

/**
 * Effective Property
 * A property definition with profile-specific configuration (inheritance resolved)
 */
export interface EffectiveProperty extends PropertyDef {
  required: boolean;
  defaultValue: unknown;
  displayOrder: number;
}
