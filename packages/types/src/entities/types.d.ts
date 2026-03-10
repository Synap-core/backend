/**
 * Entity Types
 *
 * TypeScript types for entities with profile-based dynamic types.
 * Entity types are now dynamic (profiles), not hardcoded enums.
 */
import { type z } from "zod";
/**
 * Entity Schema - Profile-Based (Dynamic Types)
 *
 * Entities now use profiles for dynamic type definitions.
 * Properties are validated against profile schemas.
 */
export declare const EntitySchema: z.ZodObject<
  {
    id: z.ZodString;
    userId: z.ZodString;
    workspaceId: z.ZodNullable<z.ZodString>;
    type: z.ZodString;
    profileId: z.ZodNullable<z.ZodString>;
    title: z.ZodNullable<z.ZodString>;
    preview: z.ZodNullable<z.ZodString>;
    documentId: z.ZodNullable<z.ZodString>;
    properties: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    fileUrl: z.ZodNullable<z.ZodString>;
    filePath: z.ZodNullable<z.ZodString>;
    fileSize: z.ZodNullable<z.ZodNumber>;
    fileType: z.ZodNullable<z.ZodString>;
    checksum: z.ZodNullable<z.ZodString>;
    version: z.ZodNumber;
    createdAt: z.ZodDate;
    updatedAt: z.ZodDate;
    deletedAt: z.ZodNullable<z.ZodDate>;
  },
  z.core.$strip
>;
/**
 * Entity - The main type used across the application
 */
export type Entity = z.infer<typeof EntitySchema>;
/**
 * Base Entity Helper (alias for clarity)
 */
export type BaseEntity = Entity;
/**
 * New entity type (for creation)
 */
export type NewEntity = Omit<
  Entity,
  "id" | "version" | "createdAt" | "updatedAt" | "deletedAt"
> & {
  profileSlug: string;
  properties: Record<string, unknown>;
};
/**
 * Entity update type (for updates)
 */
export type UpdateEntity = Partial<
  Omit<
    Entity,
    | "id"
    | "userId"
    | "type"
    | "profileId"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
  >
> & {
  properties?: Record<string, unknown>;
};
/**
 * @deprecated EntityType enum - Use profile slugs (strings) instead
 * Kept for backward compatibility during migration
 *
 * Note: EntityType is exported from schemas.ts, not here, to avoid conflicts
 */
/**
 * @deprecated Type-specific entity types - Profiles are dynamic
 * Use Entity type with profileId/profileSlug instead
 */
//# sourceMappingURL=types.d.ts.map
