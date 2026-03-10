/**
 * Profile System Types
 *
 * Types for the dynamic profile-based entity type system.
 * Profiles define entity types as configuration, not code.
 */
import { z } from "zod";
/**
 * Profile Schema
 */
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  parentProfileId: z.string().uuid().nullable(),
  uiHints: z.record(z.string(), z.unknown()),
  scope: z.enum(["system", "workspace", "user"]),
  userId: z.string().nullable(),
  workspaceId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
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
  ]),
  constraints: z.record(z.string(), z.unknown()),
  uiHints: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});
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
//# sourceMappingURL=index.js.map
