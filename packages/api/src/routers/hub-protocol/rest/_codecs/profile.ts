/**
 * Profile / PropertyDef Wire Codecs — Hub Protocol REST schemas for entity
 * profiles and their property definitions.
 *
 * Profiles define the shape of entities (e.g. task, project, person). Property
 * defs declare the typed properties that can be set on entities of a given
 * profile. Both are mutable at runtime and govern how entities are validated,
 * indexed, and rendered.
 */

import { z } from "@hono/zod-openapi";

/** Wire shape for a profile row. */
export const WireProfileSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    displayName: z.string(),
    description: z.string().nullable().optional(),
    parentProfileId: z.string().nullable().optional(),
    entityScope: z.enum(["pod", "workspace"]).optional(),
    workspaceId: z.string().nullable().optional(),
    defaultValues: z.record(z.string(), z.unknown()).optional(),
    uiHints: z.record(z.string(), z.unknown()).optional(),
    icon: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("Profile");

/** Wire shape for a property definition. */
export const WirePropertyDefSchema = z
  .object({
    id: z.string(),
    profileId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    slug: z.string(),
    valueType: z.string(),
    constraints: z.record(z.string(), z.unknown()).optional(),
    uiHints: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("PropertyDef");

/** GET /profiles query. */
export const ListProfilesQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
  })
  .openapi("ListProfilesQuery");

/** POST /profiles request. */
export const CreateProfileRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    slug: z.string().describe("Stable lower-kebab profile identifier."),
    displayName: z.string(),
    description: z.string().optional(),
    defaultValues: z.record(z.string(), z.unknown()).optional(),
    parentProfileId: z
      .string()
      .optional()
      .describe("Parent profile to inherit properties from."),
    uiHints: z.record(z.string(), z.unknown()).optional(),
    reasoning: z.string().optional(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("CreateProfileRequest");

/** GET /property-defs query. */
export const ListPropertyDefsQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    profileId: z
      .string()
      .optional()
      .describe("Filter to defs attached to a specific profile."),
  })
  .openapi("ListPropertyDefsQuery");

/** POST /property-defs request. */
export const CreatePropertyDefRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    profileId: z.string().optional(),
    slug: z.string(),
    valueType: z
      .string()
      .describe(
        "Logical type — e.g. text, number, date, boolean, select, multi_select, relation."
      ),
    constraints: z.record(z.string(), z.unknown()).optional(),
    uiHints: z.record(z.string(), z.unknown()).optional(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    overlay: z
      .boolean()
      .optional()
      .describe(
        "When true, create a workspace-scoped overlay def invisible to other workspaces using the same profile. Defaults to false (base def)."
      ),
  })
  .openapi("CreatePropertyDefRequest");
