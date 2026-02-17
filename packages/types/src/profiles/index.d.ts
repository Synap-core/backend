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
export type ProfileScope = "system" | "workspace" | "user";
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
  | "object";
/**
 * Profile Schema
 */
export declare const ProfileSchema: z.ZodObject<
  {
    id: z.ZodString;
    slug: z.ZodString;
    displayName: z.ZodString;
    parentProfileId: z.ZodNullable<z.ZodString>;
    uiHints: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    scope: z.ZodEnum<{
      user: "user";
      system: "system";
      workspace: "workspace";
    }>;
    userId: z.ZodNullable<z.ZodString>;
    workspaceId: z.ZodNullable<z.ZodString>;
    isActive: z.ZodBoolean;
    version: z.ZodNumber;
    createdAt: z.ZodDate;
    updatedAt: z.ZodDate;
  },
  z.core.$strip
>;
export type Profile = z.infer<typeof ProfileSchema>;
/**
 * Property Definition Schema
 */
export declare const PropertyDefSchema: z.ZodObject<
  {
    id: z.ZodString;
    slug: z.ZodString;
    valueType: z.ZodEnum<{
      string: "string";
      number: "number";
      boolean: "boolean";
      object: "object";
      date: "date";
      array: "array";
      entity_id: "entity_id";
    }>;
    constraints: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    uiHints: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    createdAt: z.ZodDate;
    updatedAt: z.ZodDate;
  },
  z.core.$strip
>;
export type PropertyDef = z.infer<typeof PropertyDefSchema>;
/**
 * Profile Property Link Schema
 * Links a property definition to a profile with configuration
 */
export declare const ProfilePropertySchema: z.ZodObject<
  {
    profileId: z.ZodString;
    propertyDefId: z.ZodString;
    required: z.ZodBoolean;
    defaultValue: z.ZodNullable<z.ZodUnknown>;
    displayOrder: z.ZodNumber;
  },
  z.core.$strip
>;
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
//# sourceMappingURL=index.d.ts.map
