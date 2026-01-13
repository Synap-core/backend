/**
 * Entity Metadata Schemas
 *
 * Defines Zod schemas for all entity types.
 * TypeScript types are auto-generated from these schemas.
 *
 * Adding a new entity type: Just add to ENTITY_SCHEMAS!
 */

import { z } from "zod";

/**
 * Entity metadata schemas - one per entity type
 *
 * The type key MUST match the entity.type field in the database
 */
export const ENTITY_SCHEMAS = {
  task: z.object({
    status: z.enum(["todo", "in_progress", "done", "archived"]).default("todo"),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    dueDate: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    assignee: z.string().uuid().optional(),
    estimatedMinutes: z.number().int().positive().optional(),
    actualMinutes: z.number().int().positive().optional(),
  }),

  note: z.object({
    tags: z.array(z.string()).default([]),
    format: z.enum(["markdown", "plain", "rich"]).default("markdown"),
    linkedEntities: z.array(z.string().uuid()).optional(),
    isFavorite: z.boolean().default(false),
  }),

  person: z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    role: z.string().optional(),
    linkedInUrl: z.string().url().optional(),
    twitterHandle: z.string().optional(),
    notes: z.string().optional(),
  }),

  event: z.object({
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    location: z.string().optional(),
    attendees: z.array(z.string().uuid()).optional(),
    recurring: z.boolean().default(false),
    recurrenceRule: z.string().optional(), // iCal RRULE format
    isAllDay: z.boolean().default(false),
    reminderMinutes: z.number().int().optional(),
  }),

  file: z.object({
    mimeType: z.string(),
    sizeBytes: z.number().int().positive(),
    extension: z.string(),
    thumbnailUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
  }),

  code: z.object({
    language: z.string(),
    snippet: z.string().optional(),
  }),

  bookmark: z.object({
    url: z.string().url(),
    favicon: z.string().optional(),
  }),

  company: z.object({
    website: z.string().url().optional(),
    industry: z.string().optional(),
    foundedYear: z.number().int().optional(),
  }),
} as const;

/**
 * Entity type enum - auto-generated from schema keys
 */
export type EntityType = keyof typeof ENTITY_SCHEMAS;

/**
 * Entity metadata types - auto-generated from schemas
 */
export type EntityMetadata = {
  [K in EntityType]: z.infer<(typeof ENTITY_SCHEMAS)[K]>;
};

/**
 * Validation helper - validates metadata for a specific entity type
 * Returns parsed metadata with proper typing
 */
export function validateEntityMetadata<T extends EntityType>(
  type: T,
  metadata: unknown,
): z.infer<(typeof ENTITY_SCHEMAS)[T]> {
  return ENTITY_SCHEMAS[type].parse(metadata) as z.infer<
    (typeof ENTITY_SCHEMAS)[T]
  >;
}

/**
 * Safe validation helper - returns result with success/error
 */
export function safeValidateEntityMetadata<T extends EntityType>(
  type: T,
  metadata: unknown,
) {
  return ENTITY_SCHEMAS[type].safeParse(metadata);
}
