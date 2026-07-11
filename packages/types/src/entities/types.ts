/**
 * Entity Types
 *
 * TypeScript types for entities with profile-based dynamic types.
 * Entity types are now dynamic (profiles), not hardcoded enums.
 */

import { z } from "zod";

/**
 * Entity Schema - Profile-Based (Dynamic Types)
 *
 * Entities now use profiles for dynamic type definitions.
 * Properties are validated against profile schemas.
 */
export const EntitySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  workspaceId: z.string().nullable(),
  type: z.string(), // Profile slug (dynamic, not enum)
  profileId: z.string().uuid().nullable(), // FK to profiles table
  title: z.string().nullable(),
  preview: z.string().nullable(),
  documentId: z.string().uuid().nullable(),
  properties: z.record(z.string(), z.unknown()), // Validated properties (source of truth)
  // metadata field removed - use properties instead
  /** System-managed state. Not validated against profile schema. Not shown in property editors. */
  systemData: z.record(z.string(), z.unknown()).optional(),
  fileUrl: z.string().nullable(),
  filePath: z.string().nullable(),
  fileSize: z.number().nullable(),
  fileType: z.string().nullable(),
  checksum: z.string().nullable(),
  // Projects: Removed projectIds (use relations table with type "belongs_to_project")
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
  /**
   * Kind + Facets: the role-profile slugs this entity currently wears (its
   * "hats"), e.g. `["client", "investor"]`. Additive/optional — populated by
   * list/search/retrieval read paths via one batched facet load, absent when
   * the entity wears no role. Slugs only (lightest shape); display name / color
   * resolve from the profile catalog the consumer already holds. The full facet
   * detail (status, workspaceId, properties) lives on `entities.get`'s
   * `effectiveFacets`.
   */
  facetSlugs: z.array(z.string()).optional(),
});

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
  profileSlug: string; // Required for creation (or profileId)
  properties: Record<string, unknown>; // Required, validated against profile
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
  properties?: Record<string, unknown>; // Optional, validated against profile
};

/**
 * @deprecated EntityType enum - Use profile slugs (strings) instead
 * Kept for backward compatibility during migration
 *
 * Note: EntityType is exported from schemas.ts, not here, to avoid conflicts
 */
// EntityType is exported from schemas.ts

/**
 * @deprecated Type-specific entity types - Profiles are dynamic
 * Use Entity type with profileId/profileSlug instead
 */
// Removed: Task, Note, Person, Event, File, Contact, Meeting, Idea, Project
