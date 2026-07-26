/**
 * Channel Wire Codecs — Hub Protocol REST schemas for the auxiliary channel
 * REST endpoints (resolve by context, fetch personal, AI trigger).
 */

import { z } from "@hono/zod-openapi";

/** Wire shape of a channel row. */
export const WireChannelSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    type: z.string().optional(),
    family: z.string().optional(),
    userId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    contextObjectId: z.string().nullable().optional(),
    contextObjectType: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Channel");

/** POST /channels/by-context request body. */
export const ChannelByContextRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().optional(),
    contextObjectId: z.string(),
    contextObjectType: z.enum(["entity", "document", "view", "proposal"]),
  })
  .openapi("ChannelByContextRequest");

/** POST /channels/by-context response. */
export const ChannelByContextResponseSchema = z
  .object({
    channelId: z.string(),
    title: z.string().nullable().optional(),
    created: z.boolean(),
    channel: WireChannelSchema,
  })
  .openapi("ChannelByContextResponse");

/** GET /channels/personal query. */
export const PersonalChannelQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
  })
  .openapi("PersonalChannelQuery");

/** POST /channels/trigger-ai request body. */
export const TriggerAiRequestSchema = z
  .object({
    channelId: z.string(),
    userId: z.string(),
    workspaceId: z.string(),
    systemPromptOverride: z.string(),
    skillId: z.string().optional(),
    entityId: z
      .string()
      .optional()
      .describe("Entity to inject as context for the AI response."),
  })
  .openapi("TriggerAiRequest");
