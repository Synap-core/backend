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
  asc,
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
import { resolveIdentity } from "@synap/database";
import { resolveExistingExternalUser } from "../external-user-mapping.js";

const logger = createLogger({ module: "inbound-recorder" });

// ── Channel resolve ───────────────────────────────────────────────────────────

/** Read-only lookup of the EXTERNAL channel bound to (provider, externalId). */
export async function resolveExternalChannel(args: {
  provider: string;
  externalId: string;
}): Promise<{
  id: string;
  userId: string;
  workspaceId: string | null;
  contextObjectId: string | null;
  branchPurpose: string | null;
} | null> {
  const row = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, args.provider),
      eq(channels.externalId, args.externalId)
    ),
    columns: {
      id: true,
      userId: true,
      workspaceId: true,
      contextObjectId: true,
      branchPurpose: true,
    },
    // Deterministic oldest-wins so a duplicate external channel resolves to a
    // stable survivor run-to-run.
    orderBy: [asc(channels.createdAt)],
  });
  return row
    ? {
        id: row.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        contextObjectId: row.contextObjectId,
        branchPurpose: row.branchPurpose,
      }
    : null;
}

export interface ResolveOrCreateExternalChannelArgs {
  provider: string;
  externalId: string;
  userId: string;
  /**
   * Workspace home for a freshly-created channel. `null` (Wave 3) creates the
   * channel pod-level (no workspace pin) — `channels.workspaceId` is nullable —
   * so a pod-wide inbound isn't forced into one workspace. Non-null pins it.
   */
  workspaceId: string | null;
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
  /**
   * Proposal approval must never rebind a channel that belongs to another
   * workspace, even when the same operator owns both. Explicit user-driven
   * relink flows leave this false and make that move separately.
   */
  requireExistingWorkspace?: boolean;
}

export class ExternalChannelOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalChannelOwnershipError";
  }
}

function assertExternalChannelOwner(
  existing: { userId: string; workspaceId: string | null },
  args: ResolveOrCreateExternalChannelArgs
): void {
  if (existing.userId !== args.userId) {
    throw new ExternalChannelOwnershipError(
      "External channel belongs to a different user"
    );
  }
  if (
    args.requireExistingWorkspace &&
    existing.workspaceId !== args.workspaceId
  ) {
    throw new ExternalChannelOwnershipError(
      "External channel belongs to a different workspace"
    );
  }
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
    assertExternalChannelOwner(existing, args);
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

  // Link-at-birth (STRONG signal only): if the external participant is already a
  // known subject — its `${provider}:${participantExternalId}` external-id is
  // registered in entity_identity_signals — bind the new channel to that entity
  // and title it after the subject, so a Discord/Telegram channel lands linked to
  // the real client instead of orphaned. WEAK (name-only) matches never auto-link
  // per the frozen identity policy; those are left null for the review queue / an
  // AI-guess proposal (the fuzzy path — a follow-up that needs the proposal UX).
  let bornContextObjectId: string | null = null;
  let bornContextObjectType: string | null = null;
  let titleAtBirth = args.title;
  if (args.participantExternalId) {
    const resolution = await resolveIdentity(db, {
      userId: args.userId,
      signals: [
        {
          type: "external_id",
          value: `${args.provider}:${args.participantExternalId}`,
        },
      ],
    });
    if (resolution.match === "strong" && resolution.entity) {
      bornContextObjectId = resolution.entity.id;
      bornContextObjectType = "entity";
      if (resolution.entity.title) titleAtBirth = resolution.entity.title;
    }
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
      title: titleAtBirth,
      contextObjectType: bornContextObjectType,
      contextObjectId: bornContextObjectId,
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
        linkedEntityId: bornContextObjectId,
      },
      bornContextObjectId
        ? "Auto-created EXTERNAL channel for inbound message, linked at birth (strong signal)"
        : "Auto-created EXTERNAL channel for inbound message (unlinked — no strong match)"
    );
    return { channelId: inserted.id, contextObjectId: bornContextObjectId };
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
  assertExternalChannelOwner(survivor, args);
  return { channelId: survivor.id, contextObjectId: survivor.contextObjectId };
}

// ── Inbound message record ─────────────────────────────────────────────────────

export interface RecordInboundMessageArgs {
  provider: string;
  /** External thread/channel id (the channel dedup key). */
  externalId: string;
  userId: string;
  /**
   * Workspace home for a freshly-created channel (Wave 3). `null` records the
   * inbound against a pod-level channel (no workspace pin); non-null pins it.
   */
  workspaceId: string | null;
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
  /**
   * The native message id from the external provider (e.g. Discord snowflake).
   * Surfaced in the `external_message.received` event data so automations can
   * read `{{trigger.payload.data.messageId}}` and later pin or reference the
   * source message.
   */
  messageId?: string;
  /**
   * Attachments carried on the inbound message (e.g. Discord photo embeds).
   * Stored under `messages.metadata.attachments` (schema: {type,url} — `name` is
   * dropped to match ConversationMessageMetadataSchema's AttachmentSchema) and
   * surfaced (bounded) on the `external_message.received` event. ADDITIVE
   * METADATA ONLY: attachments are never part of the idempotency hash
   * (sha256(provider:idempotencySeed)) nor the tamper hash, so carrying them
   * cannot affect either chain.
   */
  attachments?: { type: string; url: string; name?: string }[];
  /**
   * Provenance override for the stored message row. Defaults to the historical
   * inbound shape (`authorType=EXTERNAL`, `role=USER`) when omitted, so every
   * existing caller (Discord bridge, Unipile webhook) is byte-for-byte unchanged.
   *
   * Set `authorType=HUMAN` + `role=ASSISTANT` to record an OUTBOUND message —
   * the operator's OWN sent message — so the inbox renders it right-aligned
   * instead of mis-attributing it to the external contact. This is the seam the
   * LinkedIn/Unipile thread backfill uses to reconstruct both sides of a
   * conversation from a single provider message list.
   */
  authorType?: MessageAuthorType;
  role?: MessageRole;
  /**
   * When true, SKIP the `external_message.received` side-effect emit (channel
   * resolve + dedup insert still run). Defaults to false — today's behavior.
   *
   * Rationale: a bulk backfill/reconciliation of HISTORICAL messages must NOT
   * fan out `external_message.received` per message. That event drives
   * `webhookDeliveryReactor` + `automationTriggerMatchReactor`, so the first
   * backfill would otherwise replay an entire thread's history into any
   * auto-reply automation. Live inbound (the default) keeps firing the event.
   */
  suppressSideEffects?: boolean;
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
      // Default = historical inbound shape (EXTERNAL/USER); an OUTBOUND backfill
      // overrides to HUMAN/ASSISTANT so the inbox attributes it to the operator.
      role: args.role ?? MessageRole.USER,
      authorType: args.authorType ?? MessageAuthorType.EXTERNAL,
      messageCategory: MessageCategory.CHAT,
      externalSource: args.provider,
      content: args.text,
      hash: inboundHash,
      timestamp: sentAt,
      // ONE merged metadata object — `sender` (attribution) and `attachments`
      // (inbound media) coexist. Attachments are stored as {type,url} to match
      // ConversationMessageMetadataSchema.attachments (AttachmentSchema drops
      // `name`) and bounded to 4. Written only when at least one is present so a
      // plain text message keeps a null metadata column as before.
      ...(senderMetadata || args.attachments?.length
        ? {
            metadata: {
              ...(senderMetadata ? { sender: senderMetadata } : {}),
              ...(args.attachments?.length
                ? {
                    attachments: args.attachments
                      .slice(0, 4)
                      .map((a) => ({ type: a.type, url: a.url })),
                  }
                : {}),
            } as (typeof messages.$inferInsert)["metadata"],
          }
        : {}),
    })
    .onConflictDoNothing(); // idempotent — webhook may fire more than once

  logger.info(
    { channelId, provider: args.provider, externalId: args.externalId },
    "Inbound message stored"
  );

  // Bulk backfill/reconciliation suppresses the fan-out so historical messages
  // don't replay through webhook + automation-trigger reactors. Everything above
  // (channel resolve + dedup insert) already ran; only the emit is skipped.
  if (args.suppressSideEffects) {
    return { channelId, contextObjectId, inboundHash, recorded: true };
  }

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
      messageId: args.messageId,
      participantName: args.participant,
      messagePreview: preview,
      // Full text so automations can extract URLs/structure past the 120-char
      // preview. Bounded to 4k: this `data` blob is persisted verbatim in
      // automation_runs.trigger_payload (+ forwarded to webhook subscribers), so
      // an unbounded body would bloat the run log and over-expose message text.
      // 4k covers any real chat message (Discord caps at 2k/4k); links live early.
      content: args.text.slice(0, 4000),
      // Bounded attachment list (cap 4, {type,url} only) so automations/webhooks
      // can see inbound media. Same defensive bounding as `content`: this blob is
      // persisted verbatim in automation_runs.trigger_payload + forwarded to
      // webhook subscribers, so it must stay small.
      ...(args.attachments?.length
        ? {
            attachments: args.attachments
              .slice(0, 4)
              .map((a) => ({ type: a.type, url: a.url })),
          }
        : {}),
    },
  }).catch((err) => {
    logger.warn({ err, channelId }, "emitSideEffects failed (non-fatal)");
  });

  return { channelId, contextObjectId, inboundHash, recorded: true };
}
