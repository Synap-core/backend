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
    lead: z
      .object({
        kind: z.enum(["person", "company"]),
        id: z.string(),
        stage: z.string().nullable(),
      })
      .describe(
        "The lead this person is listed for: themselves (`person`), or the company they work at that is a lead of the space (`company`, its id). `stage` is that role's status in the space, null when it has none."
      ),
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

/** The words of a message the person writes: one limit for send and save. */
const MessageTextSchema = z.string().trim().min(1).max(8000);
const MessageSubjectSchema = z.string().max(500);
const expectedRevisionSchema = () =>
  z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "The draft's revision you read (`revisionHistory.length`): a draft revised since is refused (409)."
    );

/** POST /channels/{channelId}/send body. */
export const ChannelSendRequestSchema = z
  .object({
    text: MessageTextSchema,
    subject: MessageSubjectSchema.optional(),
    draftId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The draft this sends: its text is replaced by `text` (the recipient stays), then it is approved."
      ),
    expectedRevision: expectedRevisionSchema(),
  })
  .openapi("ChannelSendRequest");

/** PUT /channels/{channelId}/drafts/{draftId} body. */
export const ChannelDraftSaveRequestSchema = z
  .object({
    text: MessageTextSchema.describe(
      "The draft's words, as the person left them."
    ),
    subject: MessageSubjectSchema.optional(),
    expectedRevision: expectedRevisionSchema(),
  })
  .openapi("ChannelDraftSaveRequest");

export const ChannelDraftSaveResponseSchema = z
  .object({
    draftId: z.string(),
    revision: z
      .number()
      .int()
      .describe(
        "The draft's revision after the save (`revisionHistory.length`): pass it as `expectedRevision` on the send."
      ),
    changed: z
      .boolean()
      .describe("false = the words were already these: nothing was recorded."),
    status: z
      .string()
      .describe(
        "The draft's status after the save: `pending` (a failed send the person reworded is reopened as pending)."
      ),
  })
  .openapi("ChannelDraftSaveResponse");

export const ChannelDraftVersionSchema = z
  .object({
    version: z
      .number()
      .int()
      .describe("1 = the first words, then each change in order."),
    author: z
      .enum(["ai", "person"])
      .describe("ai = written by an agent; person = written by the person."),
    authorId: z.string().nullable(),
    at: z.string().describe("When these words were written (ISO 8601)."),
    text: z.string(),
    subject: z.string().optional(),
  })
  .openapi("ChannelDraftVersion");

export const ChannelDraftVersionsResponseSchema = z
  .object({
    draftId: z.string(),
    revision: z
      .number()
      .int()
      .describe("The draft's revision now (`revisionHistory.length`)."),
    versions: z
      .array(ChannelDraftVersionSchema)
      .describe("Oldest first; the last is the draft's words now."),
  })
  .openapi("ChannelDraftVersionsResponse");

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
