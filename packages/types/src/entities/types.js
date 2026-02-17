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
});
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
//# sourceMappingURL=types.js.map