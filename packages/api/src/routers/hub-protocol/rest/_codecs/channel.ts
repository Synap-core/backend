/**
 * Channel Wire Codecs — Hub Protocol REST schemas for the auxiliary channel
 * REST endpoints (resolve by context, fetch personal, AI trigger).
 */

import { z } from "@hono/zod-openapi";
import { uuidQueryParam } from "./_openapi.js";

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

/**
 * POST /channels/by-context request body.
 *
 * SECURITY: "proposal" is intentionally EXCLUDED here. A proposal-bound thread is
 * hydrated into the AI prompt from its unvalidated primary binding, so a guessed
 * proposal UUID on this service-key REST door would be an IDOR. The legitimate
 * "Discuss a proposal" flow reaches the backend via the user-session tRPC
 * `channels.resolveOrCreateChannel` door (which keeps "proposal" and gates it),
 * NOT this by-context door.
 */
export const ChannelByContextRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: uuidQueryParam.optional(),
    contextObjectId: z.string(),
    contextObjectType: z.enum(["entity", "document", "view"]),
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
    workspaceId: uuidQueryParam,
  })
  .openapi("PersonalChannelQuery");

/** POST /channels/trigger-ai request body. */
export const TriggerAiRequestSchema = z
  .object({
    channelId: z.string(),
    userId: z.string(),
    workspaceId: uuidQueryParam,
    systemPromptOverride: z.string(),
    skillId: z.string().optional(),
    entityId: z
      .string()
      .optional()
      .describe("Entity to inject as context for the AI response."),
  })
  .openapi("TriggerAiRequest");

// ── A person's channels (channels wave, design d00cd2ac §6) ────────────────

/** The last message of a channel with a person (content ≤ 200 chars). */
export const PodChannelLastMessageSchema = z
  .object({
    content: z.string(),
    at: z.string(),
    direction: z.enum(["inbound", "outbound"]).nullable(),
  })
  .openapi("PodChannelLastMessage");

/** One conversation with a person: GET /entities/:id/channels. */
export const PodChannelSchema = z
  .object({
    id: z.string(),
    provider: z.string().nullable(),
    accountId: z.string().nullable(),
    title: z.string().nullable(),
    externalId: z
      .string()
      .nullable()
      .describe(
        "The tool's chat id; null until the first send opens the chat."
      ),
    participant: z.object({
      name: z.string().nullable(),
      externalId: z.string().nullable(),
    }),
    lastMessage: PodChannelLastMessageSchema.nullable(),
    unread: z.number().int(),
    pendingProposals: z.number().int(),
  })
  .openapi("PodChannel");

export const EntityChannelsResponseSchema = z
  .object({ channels: z.array(PodChannelSchema) })
  .openapi("EntityChannelsResponse");

/** A proposed message: the pending send proposal filed for the channel. */
export const ProposedMessageSchema = z
  .object({
    proposalId: z.string(),
    text: z.string(),
    createdAt: z.string(),
    draftedBy: z
      .object({ agentUserId: z.string(), name: z.string().nullable() })
      .nullable(),
    reviewUrl: z.string(),
  })
  .openapi("ProposedMessage");

export const ProposedMessagesResponseSchema = z
  .object({ proposed: z.array(ProposedMessageSchema) })
  .openapi("ProposedMessagesResponse");
