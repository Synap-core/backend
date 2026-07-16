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
   *
   * This is the DEFAULT annotation on every list path and stays that way: its
   * consumers (role chips, graph adapters, view-renderer, search indexing) need
   * only the hats, and the slug load is the cheap one. See `facets` below when
   * a slug is not enough.
   */
  facetSlugs: z.array(z.string()).optional(),
  /**
   * Kind + Facets, RICH shape: each live facet's overlay alongside its slug.
   * Present ONLY when the caller explicitly opts in (`entities.list`'s
   * `includeFacets: true`) — never on the default list response, which carries
   * `facetSlugs` alone.
   *
   * Opt-in because `facetSlugs` is lossy for a consumer that must read a facet
   * PROPERTY on a list page: e.g. the `lead` role's `leadStage: "prospect"`
   * separates a Prospect from a plain Lead, and a slug cannot express it — the
   * distinction was previously visible only on `entities.get`. Callers that
   * just chip the hats should stay on the default and skip the wider load.
   */
  facets: z
    .array(
      z.object({
        facetId: z.string().uuid(),
        slug: z.string(),
        properties: z.record(z.string(), z.unknown()),
        status: z.string().nullable(),
      })
    )
    .optional(),
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
