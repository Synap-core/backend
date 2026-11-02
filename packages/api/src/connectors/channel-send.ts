/**
 * A message to a person, through their channel (channels wave, lane D,
 * design d00cd2ac §4). The channel IS the conversation: the send door
 * (`sendExternalMessage`) is the audited chokepoint that calls the provider;
 * this module holds what it needs around that call for a send that names a
 * channel: plan it (before), record it (after).
 *
 *  - The grant check: a key may send on a person's channel when it may read
 *    that person and may send (`capability.send_message.run`, the intent an
 *    app asks for, or `messaging.send`) in the space it acts in. A channel
 *    bound to a person follows the person (founder decision 3), so the
 *    channel's own space stamp (none, for a pod-wide external channel) is not
 *    what decides.
 *  - The account: the person's own connected account, named by the channel
 *    (`metadata.accountId`) or the caller, owned by the channel's owner.
 *  - The plan: with a chat id, a message into that chat. Without one (a
 *    channel opened at the first draft), the attendee is resolved (the
 *    channel's participant id, else the person's `<provider>ProviderId`, else a
 *    profile lookup by their public identifier), anyone who is not a
 *    1st-degree connection is refused BEFORE anything is sent
 *    (`not_connected`), the chat is started, and its id fills the channel. If
 *    the chat already belongs to another channel (the provider's echo opened
 *    one first), the pending channel is archived and the message lands there.
 *  - The record: ONE outbound row (`direction` outbound, `delivery_status`
 *    sent, the provider's message id) through `insertChannelMessage`; when the
 *    provider's echo landed first, that row gets this send's metadata.
 *  - Events: `message.sent` in the log (with the person) and
 *    `external_message.sent` for automations; "when did we last speak" moves.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  getRequestGrant,
  insertChannelMessage,
  registerIdentitySignals,
  noteInteractionsFrom,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  MessageDirection,
  MessageDeliveryStatus,
} from "@synap/database";
import {
  channels,
  ChannelType,
  entities,
  messagingAccounts,
} from "@synap/database/schema";
import { emitSideEffects } from "@synap/events";
import { humanizeToken } from "@synap-core/types/vocabulary";
import type { FailureErrorClass } from "@synap-core/types/failures";
import type { MessagingConnector } from "./MessagingConnector.js";
import {
  grantWriteDenial,
  runCollectingGrantDenials,
  type GrantWriteInput,
} from "../utils/grant-write-check.js";
import {
  linkedinSlug,
  readableRecipient,
} from "../services/capabilities/intent-recipient.js";

const logger = createLogger({ module: "channel-send" });

/** The channel columns a send reads. */
export const SEND_CHANNEL_COLUMNS = {
  id: true,
  userId: true,
  workspaceId: true,
  channelType: true,
  status: true,
  title: true,
  externalSource: true,
  externalId: true,
  contextObjectType: true,
  contextObjectId: true,
  branchPurpose: true,
  metadata: true,
} as const;

export interface SendChannel {
  id: string;
  userId: string;
  workspaceId: string | null;
  channelType: string;
  status: string;
  title: string | null;
  externalSource: string | null;
  externalId: string | null;
  contextObjectType: string | null;
  contextObjectId: string | null;
  branchPurpose: string | null;
  metadata: unknown;
}

/** Who drafted a send, for the proposal and the message row. */
export interface DraftedBy {
  agentUserId: string | null;
  appClientId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** The channel's metadata bag. */
export const channelMeta = (c: { metadata: unknown }) =>
  isRecord(c.metadata) ? c.metadata : {};

/** The person a channel is bound to, or null. */
export const channelPersonId = (c: SendChannel): string | null =>
  c.contextObjectType === "entity" ? (c.contextObjectId ?? null) : null;

/** One EXTERNAL channel by id, or null. */
export async function loadSendChannel(
  channelId: string
): Promise<SendChannel | null> {
  const row = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: SEND_CHANNEL_COLUMNS,
  });
  return (row as SendChannel | undefined) ?? null;
}

/** A grant check that leaves no denial record behind (a tried alternative). */
const quietDenial = (input: GrantWriteInput) =>
  runCollectingGrantDenials([], () => grantWriteDenial(input));

/**
 * null when the calling key may send on this channel; the refusal otherwise.
 * No grant (a signed-in person, a job) → null.
 *
 * Passes when the key holds `messaging.send` in the channel's space (the
 * check this door always made), OR — for a channel bound to a person — when
 * the key may read that person and holds `capability.send_message.run` or
 * `messaging.send` in the space it acts in. A pod-wide channel no longer fails
 * closed for an app that reads the person (the CRM).
 */
export async function messagingSendGrantDenial(args: {
  channel: Pick<
    SendChannel,
    "workspaceId" | "contextObjectType" | "contextObjectId"
  > | null;
  userId: string;
  agentUserId: string | null;
  actingWorkspaceId: string | null;
}): Promise<string | null> {
  if (!getRequestGrant()) return null;
  const own: GrantWriteInput = {
    subjectType: "messaging",
    action: "send",
    workspaceId: args.channel?.workspaceId ?? null,
  };
  if (!(await quietDenial(own))) return null;
  const personId =
    args.channel?.contextObjectType === "entity"
      ? args.channel.contextObjectId
      : null;
  if (personId) {
    const person = await readableRecipient(
      { userId: args.userId, agentUserId: args.agentUserId },
      personId
    );
    if (person) {
      for (const alt of [
        {
          subjectType: "capability",
          action: "run",
          workspaceId: args.actingWorkspaceId,
          data: { intent: "send_message" },
        },
        {
          subjectType: "messaging",
          action: "send",
          workspaceId: args.actingWorkspaceId,
        },
      ] satisfies GrantWriteInput[]) {
        if (!(await quietDenial(alt))) return null;
      }
    }
  }
  // Refused: record it (the door's 403 carries the code) and say why.
  return grantWriteDenial(own);
}

/**
 * The provider account a channel send goes out through: the one named (by
 * the caller, else the channel), else the owner's only connected account on
 * the channel's tool — always one the channel's OWNER holds. null = none.
 */
export async function resolveSendAccount(
  channel: SendChannel,
  named: string | null | undefined
): Promise<string | null> {
  const wanted = text(named) ?? text(channelMeta(channel).accountId);
  if (wanted) {
    const [row] = await db
      .select({ externalId: messagingAccounts.externalId })
      .from(messagingAccounts)
      .where(
        and(
          eq(messagingAccounts.userId, channel.userId),
          eq(messagingAccounts.externalId, wanted)
        )
      )
      .limit(1);
    return row?.externalId ?? null;
  }
  if (!channel.externalSource) return null;
  const rows = await db
    .select({ externalId: messagingAccounts.externalId })
    .from(messagingAccounts)
    .where(
      and(
        eq(messagingAccounts.userId, channel.userId),
        drizzleSql`lower(${messagingAccounts.provider}) = lower(${channel.externalSource})`,
        eq(messagingAccounts.status, "connected")
      )
    )
    .limit(2);
  // Two accounts on one tool: the pod does not guess which one speaks.
  return rows.length === 1 ? rows[0]!.externalId : null;
}

/** The property a person's id on a tool lives in: `linkedin` → `linkedinProviderId`. */
const providerIdProperty = (provider: string) =>
  `${provider.toLowerCase().replace(/[^a-z0-9]/g, "")}ProviderId`;

/** Postgres unique violation. */
const isUniqueViolation = (err: unknown) =>
  isRecord(err) &&
  (err.code === "23505" || (isRecord(err.cause) && err.cause.code === "23505"));

/**
 * Fill a pending channel's chat id, race-safe with the provider's echo. The
 * channel the message belongs in: this one, or the one that already holds
 * the chat (the pending one is then archived).
 */
async function fillChatId(
  channel: SendChannel,
  provider: string,
  chatId: string,
  participantExternalId: string | null
): Promise<string> {
  const metaPatch = participantExternalId ? { participantExternalId } : {};
  try {
    const [filled] = await db
      .update(channels)
      .set({
        externalId: chatId,
        externalChannelId: chatId,
        metadata: drizzleSql`coalesce(${channels.metadata}, '{}'::jsonb) || ${JSON.stringify(metaPatch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(channels.id, channel.id), isNull(channels.externalId)))
      .returning({ id: channels.id });
    if (filled) return filled.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  // Someone else holds the chat (or filled this channel first).
  const holder = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, provider),
      eq(channels.externalId, chatId)
    ),
    columns: { id: true },
  });
  if (!holder) {
    logger.warn(
      { channelId: channel.id, chatId },
      "channel send: the pending channel was filled with another chat id; the message stays on it"
    );
    return channel.id;
  }
  if (holder.id !== channel.id) {
    // One conversation, one channel: the pending one is retired, never deleted.
    await db
      .update(channels)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(channels.id, channel.id), isNull(channels.externalId)));
  }
  return holder.id;
}

/** A refusal before anything was sent. */
export interface ChannelSendRefusal {
  ok: false;
  error: string;
  errorClass: FailureErrorClass;
  providerRef?: string;
}

/** How the message goes out: into the chat, or by starting it. */
export type ChannelSendPlan =
  | { ok: true; kind: "continue"; chatId: string }
  | { ok: true; kind: "start"; attendee: string }
  | ChannelSendRefusal;

/**
 * Decide how a message goes out on this channel, BEFORE anything is sent. A
 * channel with a chat id continues it. A pending one starts the chat with its
 * person: the attendee is the channel's participant id, else the person's
 * `<provider>ProviderId`, else looked up by their public identifier; anyone
 * who is not a 1st-degree connection is refused (`not_connected`). The
 * provider calls themselves are made by the send door (`sendExternalMessage`,
 * the audited chokepoint); the profile lookup here is a read.
 */
export async function planChannelSend(args: {
  channel: SendChannel;
  connector: MessagingConnector;
  accountId: string;
}): Promise<ChannelSendPlan> {
  const { channel, connector, accountId } = args;
  if (channel.externalId) {
    return { ok: true, kind: "continue", chatId: channel.externalId };
  }
  const provider = channel.externalSource ?? "unipile";
  const meta = channelMeta(channel);
  const personId = channelPersonId(channel);
  if (!connector.startChat) {
    return {
      ok: false,
      error: `${humanizeToken(provider)} cannot start a conversation from the pod.`,
      errorClass: "validation",
      providerRef: provider,
    };
  }
  const person = personId
    ? await db.query.entities.findFirst({
        where: and(eq(entities.id, personId), isNull(entities.deletedAt)),
        columns: { title: true, properties: true },
      })
    : undefined;
  const props = isRecord(person?.properties) ? person!.properties : {};
  const name = text(person?.title) ?? text(meta.participantName) ?? "them";
  let attendee =
    text(meta.participantExternalId) ??
    text(props[providerIdProperty(provider)]);
  const lookup =
    attendee ?? text(props.publicIdentifier) ?? linkedinSlug(props.linkedinUrl);
  if (connector.getProfile) {
    if (!lookup) {
      return {
        ok: false,
        error: `No ${humanizeToken(provider)} profile on file for ${name}.`,
        errorClass: "missing_field",
        providerRef: provider,
      };
    }
    const profile = await connector.getProfile(accountId, lookup);
    if (!profile) {
      return {
        ok: false,
        error: `${name} was not found on ${humanizeToken(provider)}.`,
        errorClass: "target_missing",
        providerRef: provider,
      };
    }
    // LinkedIn messages only 1st-degree connections: refused BEFORE a send.
    if (profile.networkDistance && profile.networkDistance !== "FIRST_DEGREE") {
      return {
        ok: false,
        error: `${name} is not one of your ${humanizeToken(provider)} connections yet, so a message cannot be sent. Ask to connect first.`,
        errorClass: "not_connected",
        providerRef: provider,
      };
    }
    attendee = profile.providerId;
  }
  if (!attendee) {
    return {
      ok: false,
      error: `No ${humanizeToken(provider)} id on file for ${name}.`,
      errorClass: "missing_field",
      providerRef: provider,
    };
  }
  return { ok: true, kind: "start", attendee };
}

export interface RecordedChannelSend {
  /** The channel the message landed in (another one when the chat was already held). */
  channelId: string;
  /** The message row, when it could be written or found. */
  messageId: string | undefined;
}

/**
 * Record a message the send door delivered on a person's channel: fill the
 * chat id of a channel that just started its chat (or move to the channel
 * that already holds it), the person's id on the tool as an identity signal,
 * ONE outbound row, the `external_message.sent` event, and "when did we last
 * speak". Runs after the provider accepted the message: nothing here sends.
 */
export async function recordChannelSend(args: {
  channel: SendChannel;
  chatId: string;
  externalMessageId: string | null;
  /** The chat was started by this send; its attendee. */
  started: { attendee: string } | null;
  accountId: string;
  body: string;
  /** The person sending (the row's author). */
  userId: string;
  workspaceId: string | null;
  proposalId?: string | null;
  draftedBy?: DraftedBy | null;
}): Promise<RecordedChannelSend> {
  const { channel, chatId, externalMessageId, accountId } = args;
  const provider = channel.externalSource ?? "unipile";
  const personId = channelPersonId(channel);
  let channelId = channel.id;

  if (args.started) {
    channelId = await fillChatId(
      channel,
      provider,
      chatId,
      args.started.attendee
    );
    // The person's id on the tool: the strong signal a later inbound message
    // from them binds on. Best-effort; the send already happened.
    if (personId) {
      await registerIdentitySignals(
        db,
        personId,
        [
          {
            type: "external_id",
            value: `${provider}:${args.started.attendee}`,
          },
        ],
        "send"
      ).catch((err: unknown) =>
        logger.warn({ err, personId }, "channel send: signal not recorded")
      );
    }
  }

  const written = await insertChannelMessage({
    channelId,
    content: args.body,
    userId: args.userId,
    role: MessageRole.ASSISTANT,
    authorType: MessageAuthorType.HUMAN,
    messageCategory: MessageCategory.CHAT,
    direction: MessageDirection.OUTBOUND,
    deliveryStatus: MessageDeliveryStatus.SENT,
    externalSource: provider,
    ...(externalMessageId ? { externalMessageId } : {}),
    entityId: personId,
    workspaceId: args.workspaceId,
    metadata: {
      ...(args.proposalId ? { proposalId: args.proposalId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(args.draftedBy ? { draftedBy: args.draftedBy } : {}),
    },
    // Already delivered by the connector: never mirrored out again.
    alreadyDelivered: true,
    mergeMetadataOnConflict: true,
  });

  if (written.inserted) {
    // For automations ("message sent → cadence"). The provider's echo, when it
    // landed first, already announced it (lane C, source 'provider').
    await emitSideEffects({
      subjectType: "external_message",
      action: "sent",
      subjectId: personId ?? channelId,
      userId: args.userId,
      workspaceId: args.workspaceId,
      data: {
        entityId: personId ?? undefined,
        channelId,
        provider,
        messageId: written.messageId,
        externalMessageId,
        proposalId: args.proposalId ?? null,
        first: !!args.started,
        source: "pod",
      },
    }).catch((err: unknown) =>
      logger.warn({ err, channelId }, "channel send: event not emitted")
    );
  }
  if (written.messageId && personId) {
    await noteInteractionsFrom(db as never, {
      messageIds: [written.messageId],
    }).catch((err: unknown) =>
      logger.warn({ err, personId }, "channel send: last interaction not moved")
    );
  }
  return { channelId, messageId: written.messageId };
}
