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
 *    what decides. An agent's key the grant does not reach still ASKS: its
 *    send is filed as a proposed message (`messagingSendGrantVerdict`).
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
  isNotNull,
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
  isUniqueViolation,
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
import {
  linkedinReachFromProfile,
  recordLinkedinReach,
} from "../services/connectors/linkedin-reach.js";

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

/**
 * The channel an APPROVED send goes to when the one it was filed on was
 * retired: its chat turned out to be held by another channel of the same
 * person (`fillChatId`). The person's active channel on the same tool and
 * account, with a chat. null = none.
 */
export async function successorChannel(
  retired: SendChannel
): Promise<SendChannel | null> {
  const personId = channelPersonId(retired);
  if (!personId || !retired.externalSource) return null;
  const account = text(channelMeta(retired).accountId);
  const row = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, retired.userId),
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, retired.externalSource),
      eq(channels.contextObjectType, "entity"),
      eq(channels.contextObjectId, personId),
      eq(channels.status, "active"),
      isNotNull(channels.externalId),
      account
        ? drizzleSql`coalesce(${channels.metadata} ->> 'accountId', ${account}) = ${account}`
        : undefined
    ),
    columns: SEND_CHANNEL_COLUMNS,
    orderBy: (c, { desc }) => [desc(c.updatedAt)],
  });
  return (row as SendChannel | undefined) ?? null;
}

/** A grant check that leaves no denial record behind (a tried alternative). */
const quietDenial = (input: GrantWriteInput) =>
  runCollectingGrantDenials([], () => grantWriteDenial(input));

/** Who asks for a send, on which channel, acting in which space. */
interface SendGrantArgs {
  channel: Pick<
    SendChannel,
    "workspaceId" | "contextObjectType" | "contextObjectId"
  > | null;
  userId: string;
  agentUserId: string | null;
  actingWorkspaceId: string | null;
}

/**
 * The grant check, and whether the refused key may READ the channel's
 * person (the recipient floor a beyond-grant ask needs).
 */
async function sendGrantCheck(
  args: SendGrantArgs
): Promise<{ denial: string | null; personReadable: boolean }> {
  if (!getRequestGrant()) return { denial: null, personReadable: false };
  const own: GrantWriteInput = {
    subjectType: "messaging",
    action: "send",
    workspaceId: args.channel?.workspaceId ?? null,
  };
  if (!(await quietDenial(own))) return { denial: null, personReadable: false };
  const personId =
    args.channel?.contextObjectType === "entity"
      ? args.channel.contextObjectId
      : null;
  let personReadable = false;
  if (personId) {
    const person = await readableRecipient(
      { userId: args.userId, agentUserId: args.agentUserId },
      personId
    );
    personReadable = !!person;
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
        if (!(await quietDenial(alt)))
          return { denial: null, personReadable: true };
      }
    }
  }
  // Refused: record it (the door's 403 carries the code) and say why.
  return { denial: await grantWriteDenial(own), personReadable };
}

/**
 * The key's grant on a send to a channel: null when it may send (or there is
 * no grant: a signed-in person, a job); otherwise the refusal, and whether
 * the send is still FILED for the person's approval (`proposeOnly`).
 *
 * Passes when the key holds `messaging.send` in the channel's space (the
 * check this door always made), OR — for a channel bound to a person — when
 * the key may read that person and holds `capability.send_message.run` or
 * `messaging.send` in the space it acts in. A pod-wide channel no longer fails
 * closed for an app that reads the person (the CRM).
 *
 * An AGENT asks (founder, 2026-11-03: "normally, like we do all, it should
 * still be possible, but it creates a proposal"): an agent's key whose grant
 * does not reach the send, on a channel bound to a person the key may READ,
 * gets its message filed as a proposed message on that channel. The send door
 * then forces the review (`sendExternalMessage`, `mustPropose`): nothing is
 * sent until the channel's owner approves it, and no rule can let it run on
 * its own. Everyone else keeps the refusal: an app's key (its grant names a
 * client), a person's narrowed key (no agent), and a channel with no person
 * or a person the key cannot read.
 */
export async function messagingSendGrantVerdict(
  args: SendGrantArgs
): Promise<{ denial: string; proposeOnly: boolean } | null> {
  const { denial, personReadable } = await sendGrantCheck(args);
  if (!denial) return null;
  const proposeOnly =
    !!args.agentUserId && !getRequestGrant()?.clientId && personReadable;
  return { denial, proposeOnly };
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
    // The holder follows the person too, when nobody bound it yet (an echo
    // that arrived before its person was known). A bound one is never moved.
    if (channel.contextObjectType === "entity" && channel.contextObjectId) {
      await db
        .update(channels)
        .set({
          contextObjectType: "entity",
          contextObjectId: channel.contextObjectId,
          updatedAt: new Date(),
        })
        .where(
          and(eq(channels.id, holder.id), isNull(channels.contextObjectId))
        );
    }
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
 * Who a pending channel's first message goes to, and whether the provider
 * will take it: THE reach rule, read by the send at filing
 * (`reachHoldAtFiling`) and at dispatch (`planChannelSend`), so the
 * two can never disagree. The attendee is the channel's participant id, else
 * the person's `<provider>ProviderId`, else looked up by their public
 * identifier. On LinkedIn anyone who is not a 1st-degree connection is
 * refused (`not_connected`), with the next step named; a request still
 * waiting says so. A LinkedIn answer is recorded on the person
 * (`linkedinConnection`, `linkedinInvitedAt`).
 *
 * The profile lookup is a READ. A failed read THROWS: the caller decides
 * (dispatch: a definite not-sent; filing: filed as before, the dispatch check
 * still holds). It is never read as "not connected".
 */
export async function readChannelReach(args: {
  channel: SendChannel;
  connector: MessagingConnector;
  accountId: string;
  now?: Date;
}): Promise<{ ok: true; attendee: string } | ChannelSendRefusal> {
  const { channel, connector, accountId } = args;
  const provider = channel.externalSource ?? "unipile";
  const meta = channelMeta(channel);
  const personId = channelPersonId(channel);
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
    const isLinkedin = provider.toLowerCase() === "linkedin";
    if (isLinkedin && personId) {
      const fact = linkedinReachFromProfile(profile);
      if (fact) {
        // Best effort: the verdict below stands whether or not it is stored.
        await recordLinkedinReach(personId, fact, args.now).catch((err) =>
          logger.warn(
            { err, personId },
            "channel send: the LinkedIn reach could not be recorded on the person"
          )
        );
      }
    }
    // LinkedIn messages only 1st-degree connections: refused BEFORE a send.
    // On LinkedIn an unknown distance is not a connection either (the send
    // would fail after the person approved it); elsewhere only a known
    // non-connection is refused.
    if (
      profile.networkDistance !== "FIRST_DEGREE" &&
      (isLinkedin || profile.networkDistance)
    ) {
      const where = humanizeToken(provider);
      return {
        ok: false,
        error:
          profile.connection === "pending"
            ? `${name} has not accepted your ${where} connection request yet, so a message cannot be sent. Send it once they accept.`
            : `${name} is not one of your ${where} connections yet, so a message cannot be sent. Ask to connect first.`,
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
  return { ok: true, attendee };
}

/**
 * Decide how a message goes out on this channel, BEFORE anything is sent. A
 * channel with a chat id continues it. A pending one starts the chat with its
 * person, through the reach rule (`readChannelReach`): anyone who is not a
 * 1st-degree connection is refused (`not_connected`). The provider calls
 * themselves are made by the send door (`sendExternalMessage`, the audited
 * chokepoint); the profile lookup here is a read.
 */
export async function planChannelSend(args: {
  channel: SendChannel;
  connector: MessagingConnector;
  accountId: string;
}): Promise<ChannelSendPlan> {
  const { channel, connector } = args;
  if (channel.externalId) {
    return { ok: true, kind: "continue", chatId: channel.externalId };
  }
  const provider = channel.externalSource ?? "unipile";
  if (!connector.startChat) {
    return {
      ok: false,
      error: `${humanizeToken(provider)} cannot start a conversation from the pod.`,
      errorClass: "validation",
      providerRef: provider,
    };
  }
  const reach = await readChannelReach(args);
  if (!reach.ok) return reach;
  return { ok: true, kind: "start", attendee: reach.attendee };
}

/**
 * The reach check when a send is FILED for review (not on an approved one):
 * a LinkedIn message that would start a chat with someone who is not a
 * 1st-degree connection is HELD (CRM Messages contract b4f8c2cd, B; it was
 * refused at filing since backend#786): the caller files it with
 * `data.held` and the next step named (connect first), so the draft is kept
 * and shown, never lost, and becomes sendable once they connect
 * (`services/channels/held-sends.ts`). Same rule as at dispatch
 * (`readChannelReach`).
 *
 * Only `not_connected` holds here. Everything else files as before, and the
 * dispatch check still holds: a channel with a chat (it continues), another
 * provider, no account to read with, and a read that FAILED (LinkedIn or
 * Unipile down): an unread reach is not "not connected".
 */
export async function reachHoldAtFiling(args: {
  channel: SendChannel;
  connector: MessagingConnector;
  namedAccountId: string | null | undefined;
  now?: Date;
}): Promise<ChannelSendRefusal | null> {
  const { channel, connector } = args;
  if (channel.externalId) return null;
  if ((channel.externalSource ?? "").toLowerCase() !== "linkedin") return null;
  if (!connector.startChat || !connector.getProfile) return null;
  try {
    let accountId = "";
    if (connector.requiresAccount()) {
      const resolved = await resolveSendAccount(channel, args.namedAccountId);
      if (!resolved) return null;
      accountId = resolved;
    }
    const reach = await readChannelReach({
      channel,
      connector,
      accountId,
      now: args.now,
    });
    return !reach.ok && reach.errorClass === "not_connected" ? reach : null;
  } catch (err) {
    logger.warn(
      { err, channelId: channel.id },
      "send filing: LinkedIn could not be read; filed without the reach check (the dispatch check still holds)"
    );
    return null;
  }
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
  /** A subject the caller gave; recorded, not sent (see SendExternalMessageInput.subject). */
  subject?: string | null;
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
      ...(args.subject ? { subject: args.subject } : {}),
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
