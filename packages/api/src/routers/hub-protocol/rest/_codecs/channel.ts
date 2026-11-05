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
    pendingProposals: z
      .number()
      .int()
      .describe("Pending proposed messages (held ones included)."),
    failedSends: z
      .number()
      .int()
      .describe(
        "Sends whose approval failed, kept in the conversation with their reason."
      ),
  })
  .openapi("PodChannel");

export const EntityChannelsResponseSchema = z
  .object({ channels: z.array(PodChannelSchema) })
  .openapi("EntityChannelsResponse");

/** Where a proposed message stands (services/channels/person-channels.ts). */
export const ProposedMessageStateSchema = z
  .enum(["draft", "held", "failed"])
  .describe(
    "draft = waits for the person's approval; held = waits too but cannot go out yet (not a connection: `reason` names the next step); failed = approved and did not go out (`reason` says why). A failed send is not a pending draft."
  );

/** A proposed message: a send proposal filed for the channel. */
export const ProposedMessageSchema = z
  .object({
    proposalId: z.string(),
    state: ProposedMessageStateSchema,
    reason: z.string().nullable(),
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

// ── A space's conversations (CRM Messages contract b4f8c2cd, A) ──────────

/** GET /channels/conversations query. */
export const SpaceConversationsQuerySchema = z
  .object({
    workspaceId: z
      .string()
      .uuid()
      .describe("The space: people with a facet in it are listed."),
    needsYou: z
      .enum(["true", "false"])
      .optional()
      .describe(
        "true = only the people a draft (held or not), a failed send or an unread message waits on."
      ),
    cursor: z
      .string()
      .optional()
      .describe("The `nextCursor` of the previous page."),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .openapi("SpaceConversationsQuery");

export const SpaceConversationSchema = z
  .object({
    person: z.object({
      id: z.string(),
      name: z.string().nullable(),
      company: z
        .object({ id: z.string(), name: z.string().nullable() })
        .nullable(),
    }),
    channelIds: z.array(z.string()),
    lastMessage: z
      .object({
        text: z.string(),
        at: z.string(),
        direction: z.enum(["inbound", "outbound"]).nullable(),
      })
      .nullable(),
    draft: z
      .object({
        proposalId: z.string(),
        channelId: z.string().nullable(),
        firstLine: z.string(),
        state: ProposedMessageStateSchema,
        reason: z.string().nullable(),
      })
      .nullable()
      .describe(
        "The newest draft, held draft or failed send waiting on the person; null when none."
      ),
    unread: z.number().int(),
    reach: z.object({
      linkedinConnection: z
        .enum(["none", "pending", "connected", "ignored"])
        .nullable(),
      linkedinInvitedAt: z.string().nullable(),
      hasLinkedinUrl: z.boolean(),
      hasProviderId: z.boolean(),
    }),
    lastActivityAt: z.string(),
  })
  .openapi("SpaceConversation");

export const SpaceConversationsResponseSchema = z
  .object({
    conversations: z.array(SpaceConversationSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi("SpaceConversationsResponse");

/** POST /channels/{channelId}/send body. */
export const ChannelSendRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(8000),
    subject: z.string().max(500).optional(),
    draftId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The draft this sends: its text is replaced by `text` (the recipient stays), then it is approved."
      ),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "The draft's revision you read (`revisionHistory.length`): a draft revised since is refused (409)."
      ),
  })
  .openapi("ChannelSendRequest");

export const ChannelSendResponseSchema = z
  .object({
    status: z
      .enum(["sent", "held", "failed"])
      .describe(
        "sent = it went out; held = kept as a draft, not sendable yet (`reason` names the next step); failed = it did not go out (`reason`), the text is kept on the failed send."
      ),
    proposalId: z.string(),
    reason: z.string().optional(),
  })
  .openapi("ChannelSendResponse");

/** POST /channels/linkedin-reach/{personId} answer. */
export const LinkedinReachResponseSchema = z
  .object({
    reach: z
      .enum(["none", "pending", "connected", "ignored"])
      .nullable()
      .describe(
        "The person's LinkedIn reach stored after the read (`linkedinConnection`); null when LinkedIn said nothing about it."
      ),
    invitedAt: z
      .string()
      .nullable()
      .describe("When the pending request was sent, when known."),
    providerId: z
      .string()
      .describe(
        "LinkedIn's member id for the person (stored as `linkedinProviderId` when none was)."
      ),
  })
  .openapi("LinkedinReachResponse");
