/**
 * Inbound Sensor Recorder
 *
 * ONE shared implementation of "an external message arrived" — the resolve-or-
 * create of the canonical EXTERNAL channel plus the dedup-insert of the inbound
 * message and the `external_message.received` automation event.
 *
 * Previously this exact sequence was copy-pasted across three inbound paths:
 *   • Unipile webhook  (routers/webhooks-inbound.ts, `message.created`)
 *   • Discord bridge   (routers/hub-protocol/rest/discord.ts, /discord/agent-turn)
 *   • outbound resolve (utils/delivery-router.ts, deliverToExternal) — the
 *     resolve half only.
 *
 * The channel resolve is the race-safe variant (onConflictDoNothing against the
 * PARTIAL unique index on (external_source, external_id) + re-SELECT on the lost
 * race) — strictly better than the plain findFirst/insert the Unipile path used.
 *
 * The message insert carries a sha256 idempotency hash + guard (promoted here
 * from the Discord path), so EVERY inbound provider — Unipile included — is now
 * idempotent under at-least-once webhook delivery.
 *
 * Provider-specific concerns stay at the call site: Unipile's account/workspace
 * resolution + account-lifecycle events, Discord's IS orchestrator turn.
 */

import { createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  and,
  isNotNull,
  drizzleSql,
  channels,
  messages,
  ChannelType,
  ChannelScope,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { resolveExistingExternalUser } from "../external-user-mapping.js";

const logger = createLogger({ module: "inbound-recorder" });

// ── Channel resolve ───────────────────────────────────────────────────────────

/** Read-only lookup of the EXTERNAL channel bound to (provider, externalId). */
export async function resolveExternalChannel(args: {
  provider: string;
  externalId: string;
}): Promise<{
  id: string;
  contextObjectId: string | null;
  branchPurpose: string | null;
} | null> {
  const row = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, args.provider),
      eq(channels.externalId, args.externalId)
    ),
    columns: { id: true, contextObjectId: true, branchPurpose: true },
  });
  return row
    ? {
        id: row.id,
        contextObjectId: row.contextObjectId,
        branchPurpose: row.branchPurpose,
      }
    : null;
}

export interface ResolveOrCreateExternalChannelArgs {
  provider: string;
  externalId: string;
  userId: string;
  workspaceId: string;
  /** Channel title for a freshly-created row. */
  title: string;
  /** Participant display name (cached in metadata). */
  participant?: string;
  /** Participant id in the external system (cached in metadata). */
  participantExternalId?: string;
  /** Account id in the external system (cached in metadata, Unipile). */
  accountExternalId?: string;
  /** Last-message preview to cache in metadata. */
  preview?: string;
  /** Timestamp of the last message (ISO/string); defaults to now. */
  lastMessageAt?: string;
}

/**
 * Resolve-or-create the canonical EXTERNAL channel for (provider, externalId),
 * race-safe. On an existing row, refreshes the last-message metadata cache.
 * Returns the channel id + any bound context entity.
 */
export async function resolveOrCreateExternalChannel(
  args: ResolveOrCreateExternalChannelArgs
): Promise<{ channelId: string; contextObjectId: string | null }> {
  const lastMessageAt = args.lastMessageAt ?? new Date().toISOString();

  const existing = await resolveExternalChannel({
    provider: args.provider,
    externalId: args.externalId,
  });

  if (existing) {
    await db
      .update(channels)
      .set({
        metadata: drizzleSql`${channels.metadata} || ${JSON.stringify({
          ...(args.participant ? { participantName: args.participant } : {}),
          lastMessageAt,
          lastMessagePreview: args.preview,
          unread: true,
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, existing.id));
    return {
      channelId: existing.id,
      contextObjectId: existing.contextObjectId,
    };
  }

  // Upsert against the PARTIAL unique index on (externalSource, externalId).
  // Under a concurrent first-message race the loser's insert no-ops, so we
  // re-SELECT the surviving row instead of throwing.
  const [inserted] = await db
    .insert(channels)
    .values({
      userId: args.userId,
      workspaceId: args.workspaceId,
      channelType: ChannelType.EXTERNAL,
      scope: ChannelScope.WORKSPACE,
      title: args.title,
      externalSource: args.provider,
      externalChannelId: args.externalId,
      externalId: args.externalId,
      metadata: {
        ...(args.accountExternalId
          ? { accountId: args.accountExternalId }
          : {}),
        ...(args.participant ? { participantName: args.participant } : {}),
        ...(args.participantExternalId
          ? { participantExternalId: args.participantExternalId }
          : {}),
        lastMessageAt,
        lastMessagePreview: args.preview,
        unread: true,
      },
    })
    .onConflictDoNothing({
      target: [channels.externalSource, channels.externalId],
      // The unique index is PARTIAL (`WHERE external_id IS NOT NULL`), so the
      // conflict arbiter must repeat that predicate or Postgres rejects it with
      // "no unique constraint matching the ON CONFLICT spec".
      where: isNotNull(channels.externalId),
    })
    .returning({ id: channels.id });

  if (inserted) {
    logger.info(
      {
        channelId: inserted.id,
        provider: args.provider,
        externalId: args.externalId,
      },
      "Auto-created EXTERNAL channel for inbound message"
    );
    return { channelId: inserted.id, contextObjectId: null };
  }

  // Lost the race — re-SELECT the surviving row.
  const survivor = await resolveExternalChannel({
    provider: args.provider,
    externalId: args.externalId,
  });
  if (!survivor) {
    throw new Error(
      `Failed to resolve-or-create EXTERNAL channel for ${args.provider}:${args.externalId} after conflict`
    );
  }
  return { channelId: survivor.id, contextObjectId: survivor.contextObjectId };
}

// ── Inbound message record ─────────────────────────────────────────────────────

export interface RecordInboundMessageArgs {
  provider: string;
  /** External thread/channel id (the channel dedup key). */
  externalId: string;
  userId: string;
  workspaceId: string;
  /** Message body. */
  text: string;
  /** Participant display name. */
  participant?: string;
  /** Participant id in the external system. */
  participantExternalId?: string;
  /** Account id in the external system (Unipile). */
  accountExternalId?: string;
  /** Channel title for a freshly-created row. */
  title: string;
  /**
   * Stable idempotency seed for THIS inbound message. The recorder hashes it
   * with the provider into the message `hash` column; a duplicate delivery with
   * the same seed no-ops (insert) and is reported via `recorded: false`.
   *
   * Unipile uses `${threadId}:${sentAt}:${body}` (no native message id);
   * Discord uses the gateway message id.
   */
  idempotencySeed: string;
  /** Message timestamp; defaults to now. */
  sentAt?: string | Date;
  /**
   * External user id of the message sender (e.g. Discord user id).
   * When provided together with `senderKeyId`, the recorder resolves whether
   * this sender is linked to a Synap user and stores the result in
   * `metadata.sender`. Best-effort: a lookup failure never blocks recording.
   */
  senderExternalId?: string;
  /**
   * The operator API key id used to authenticate this inbound delivery.
   * Paired with `senderExternalId` to look up the `api_key_external_users`
   * mapping table.
   */
  senderKeyId?: string;
}

export interface RecordInboundMessageResult {
  channelId: string;
  /**
   * The context entity this channel is bound to (set by /link-client via
   * contextObjectType="entity"), or null when the channel isn't client-bound.
   * Lets callers make the agent turn client-aware.
   */
  contextObjectId: string | null;
  /** The resolved inbound message hash (deterministic over provider + seed). */
  inboundHash: string;
  /** False when this exact inbound was already recorded (duplicate delivery). */
  recorded: boolean;
}

/**
 * Resolve-or-create the EXTERNAL channel, dedup-insert the inbound message
 * (role=user, authorType=external), and emit `external_message.received`.
 *
 * Idempotent: a duplicate delivery (same provider + idempotencySeed) does not
 * re-insert and returns `recorded: false`, so callers can skip duplicate work
 * (e.g. a second IS turn). The automation event only fires on a fresh record.
 */
export async function recordInboundMessage(
  args: RecordInboundMessageArgs
): Promise<RecordInboundMessageResult> {
  const preview = args.text.slice(0, 120);
  const sentAt = args.sentAt ? new Date(args.sentAt) : new Date();

  const { channelId, contextObjectId } = await resolveOrCreateExternalChannel({
    provider: args.provider,
    externalId: args.externalId,
    userId: args.userId,
    workspaceId: args.workspaceId,
    title: args.title,
    participant: args.participant,
    participantExternalId: args.participantExternalId,
    accountExternalId: args.accountExternalId,
    preview,
    lastMessageAt:
      typeof args.sentAt === "string" ? args.sentAt : sentAt.toISOString(),
  });

  const inboundHash = createHash("sha256")
    .update(`${args.provider}:${args.idempotencySeed}`)
    .digest("hex");

  // Idempotency guard: if this inbound was already recorded, report it as a
  // duplicate so the caller can skip re-doing downstream work.
  const already = await db.query.messages.findFirst({
    where: eq(messages.hash, inboundHash),
    columns: { id: true },
  });
  if (already) {
    return { channelId, contextObjectId, inboundHash, recorded: false };
  }

  // Resolve sender attribution (best-effort — never blocks recording).
  let senderMetadata: Record<string, unknown> | undefined;
  if (args.senderExternalId && args.senderKeyId) {
    try {
      const link = await resolveExistingExternalUser(
        args.senderKeyId,
        args.senderExternalId
      );
      senderMetadata = {
        name: args.participant ?? args.senderExternalId,
        externalId: args.senderExternalId,
        externalSource: args.provider,
        synapUserId: link.linked ? (link.synapUserId ?? null) : null,
      };
    } catch (err) {
      logger.warn(
        { err, senderExternalId: args.senderExternalId },
        "inbound-recorder: sender resolution failed — recording without attribution"
      );
    }
  }

  await db
    .insert(messages)
    .values({
      channelId,
      userId: args.userId,
      role: MessageRole.USER,
      authorType: MessageAuthorType.EXTERNAL,
      messageCategory: MessageCategory.CHAT,
      externalSource: args.provider,
      content: args.text,
      hash: inboundHash,
      timestamp: sentAt,
      ...(senderMetadata
        ? {
            metadata: {
              sender: senderMetadata,
            } as (typeof messages.$inferInsert)["metadata"],
          }
        : {}),
    })
    .onConflictDoNothing(); // idempotent — webhook may fire more than once

  logger.info(
    { channelId, provider: args.provider, externalId: args.externalId },
    "Inbound message stored"
  );

  // Fire for ALL inbound messages (pre-linked or not). Automations with
  // eventPattern "external_message.received.completed" match. When the channel
  // is bound to a context entity, surface it so entity-scoped automations fire.
  await emitSideEffects({
    subjectType: "external_message",
    action: "received",
    subjectId: (contextObjectId ?? channelId) as string,
    userId: args.userId,
    workspaceId: args.workspaceId,
    data: {
      entityId: contextObjectId,
      channelId,
      provider: args.provider,
      threadId: args.externalId,
      participantName: args.participant,
      messagePreview: preview,
    },
  }).catch((err) => {
    logger.warn({ err, channelId }, "emitSideEffects failed (non-fatal)");
  });

  return { channelId, contextObjectId, inboundHash, recorded: true };
}
