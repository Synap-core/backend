/**
 * Relation Wire Codecs — typed edges between two entities.
 */

import { z } from "@hono/zod-openapi";
import { uuidQueryParam } from "./_openapi.js";
import { WireEntitySchema } from "./entity.js";

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

/** Wire shape of a config-graph link (`links` row) touching an entity. */
export const WireConfigLinkSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    fromType: z.string(),
    fromId: z.string(),
    toType: z.string(),
    toId: z.string(),
    linkType: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    createdBy: z.string().nullable(),
    createdAt: z.union([z.string(), z.date()]),
  })
  .openapi("ConfigLink");

/**
 * GET /relations answer. With `entityId` it is the entity's neighbours
 * (`relations.getRelated`): the related entities plus config links, not
 * relation rows. Without `entityId` it is `{ relations }`, a page of rows.
 */
export const ListRelationsResponseSchema = z
  .union([
    z.object({
      entities: z.array(WireEntitySchema),
      configLinks: z.array(WireConfigLinkSchema),
    }),
    z.object({ relations: z.array(WireRelationSchema) }),
  ])
  .openapi("ListRelationsResponse");

/** GET /relations query. */
export const ListRelationsQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: uuidQueryParam,
    entityId: z
      .string()
      .optional()
      .describe("Filter to relations involving this entity (either side)."),
    type: z.string().optional().describe("Filter by relation type."),
    limit: z.string().optional().describe("Page size, 1-200 (default 100)."),
    offset: z
      .string()
      .optional()
      .describe(
        "Rows to skip, newest first (default 0). Not with `entityId`: that read is not paged."
      ),
  })
  .openapi("ListRelationsQuery");

/** POST /relations request body. */
export const CreateRelationRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: uuidQueryParam,
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
    workspaceId: uuidQueryParam.optional(),
    agentUserId: z.string().optional(),
    reasoning: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("DeleteRelationRequest");
