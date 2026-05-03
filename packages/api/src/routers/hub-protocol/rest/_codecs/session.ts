/**
 * Session + Compacted-state Wire Codecs — agent session-scoped memory.
 */

import { z } from "@hono/zod-openapi";

/** Wire shape of a session row. */
export const WireSessionSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    userId: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    bootstrapStateId: z.string().nullable().optional(),
    producedStateId: z.string().nullable().optional(),
    closedAt: z.union([z.string(), z.date()]).nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .openapi("Session");

/** Wire shape of a compacted state row. */
export const WireCompactedStateSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    summary: z.string().optional(),
    facts: z.array(z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("CompactedState");

/** POST /sessions/getOrCreate request body. */
export const GetOrCreateSessionRequestSchema = z
  .object({
    channelId: z.string(),
    bootstrapStateId: z
      .string()
      .optional()
      .describe("Compacted-state ID to bootstrap the session from."),
  })
  .openapi("GetOrCreateSessionRequest");

/** GET /sessions query. */
export const ListSessionsQuerySchema = z
  .object({
    channelId: z.string(),
    limit: z.string().optional(),
  })
  .openapi("ListSessionsQuery");

/** GET /sessions/active query. */
export const ActiveSessionQuerySchema = z
  .object({
    channelId: z.string(),
  })
  .openapi("ActiveSessionQuery");

/** PATCH /sessions/{sessionId} request body. */
export const UpdateSessionRequestSchema = z
  .object({
    metadata: z.record(z.string(), z.unknown()).optional(),
    bootstrapStateId: z.string().optional(),
    producedStateId: z.string().optional(),
  })
  .passthrough()
  .openapi("UpdateSessionRequest");

/** POST /sessions/{sessionId}/close request body. */
export const CloseSessionRequestSchema = z
  .object({
    producedStateId: z
      .string()
      .optional()
      .describe("Compacted-state ID written at session close."),
  })
  .openapi("CloseSessionRequest");

/** POST /compacted-states request body. */
export const CreateCompactedStateRequestSchema = z
  .object({
    channelId: z.string(),
    sessionId: z.string().optional(),
    summary: z.string().optional(),
    facts: z.array(z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .openapi("CreateCompactedStateRequest");

/** GET /compacted-states query. */
export const ListCompactedStatesQuerySchema = z
  .object({
    channelId: z.string(),
    limit: z.string().optional(),
  })
  .openapi("ListCompactedStatesQuery");
