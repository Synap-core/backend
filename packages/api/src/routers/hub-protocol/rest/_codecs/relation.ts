/**
 * Relation Wire Codecs — typed edges between two entities.
 */

import { z } from "@hono/zod-openapi";

/** Wire shape of a relation row. */
export const WireRelationSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    sourceEntityId: z.string(),
    targetEntityId: z.string(),
    type: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("Relation");

/** GET /relations query. */
export const ListRelationsQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    entityId: z
      .string()
      .optional()
      .describe("Filter to relations involving this entity (either side)."),
    type: z.string().optional().describe("Filter by relation type."),
  })
  .openapi("ListRelationsQuery");

/** POST /relations request body. */
export const CreateRelationRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    sourceEntityId: z.string(),
    targetEntityId: z.string(),
    type: z
      .string()
      .describe("Relation type identifier (e.g. parent_of, references)."),
    metadata: z.record(z.string(), z.unknown()).optional(),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("CreateRelationRequest");

/** DELETE /relations/{relationId} request body. */
export const DeleteRelationRequestSchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("DeleteRelationRequest");
