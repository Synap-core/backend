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
import { emitSideEffects, getBoss } from "@synap/events";
import { resolveIdentity } from "@synap/database";
import {
  INBOUND_ATTACHMENT_QUEUE,
  type InboundAttachmentJobData,
} from "@synap/jobs/workers/inbound-attachment-worker.js";
import { resolveExistingExternalUser } from "../external-user-mapping.js";
import {
  recordChannelOrigin,
  type ChannelOrigin,
} from "../channels/channel-origin.js";

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
  /** Cross-cutting project lens for a freshly-created channel; `null`/absent = none. */
  projectId?: string | null;
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
  /**
   * WHO produced this channel (the capability / tool / source / agent behind the
   * ingest). Written as a `producer --produced--> channel` edge at BIRTH only —
   * an existing channel keeps the origin it was born with. Absent = unknown
   * origin (every legacy channel), which reads back as `origin: null`.
   */
  origin?: ChannelOrigin;
  /**
   * Provider-native channel coordinates cached under
   * `channels.metadata.external.*` — additive JSONB, no migration. Today:
   * Discord `guildId` (required to build a channel-level discord.com deep link)
   * and Slack `teamId`. Backfilled onto EXISTING channels too, because a channel
   * born before the bridge sent the guild id would otherwise never get a link.
   */
  externalCoordinates?: { guildId?: string; teamId?: string };
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
 * Bounded `channels.metadata.external.*` patch — only the keys actually present.
 * Returns undefined when the caller supplied no coordinates, so a channel
 * without them keeps a metadata object byte-identical to before.
 */
function externalMetadataPatch(
  coords: { guildId?: string; teamId?: string } | undefined
): Record<string, string> | undefined {
  if (!coords) return undefined;
  const patch: Record<string, string> = {};
  if (coords.guildId) patch.guildId = coords.guildId;
  if (coords.teamId) patch.teamId = coords.teamId;
  return Object.keys(patch).length > 0 ? patch : undefined;
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
  const externalPatch = externalMetadataPatch(args.externalCoordinates);

  const existing = await resolveExternalChannel({
    provider: args.provider,
    externalId: args.externalId,
  });

  if (existing) {
    assertExternalChannelOwner(existing, args);
    const cacheMerge = drizzleSql`${channels.metadata} || ${JSON.stringify({
      ...(args.participant ? { participantName: args.participant } : {}),
      // Backfill the participant external-id (e.g. an email sender address) on
      // EXISTING channels too, not just at birth — the send side resolves a
      // reply recipient from it, and a channel born before it was supplied (or
      // keyed on an entity UUID) would otherwise never cache it.
      ...(args.participantExternalId
        ? { participantExternalId: args.participantExternalId }
        : {}),
      lastMessageAt,
      lastMessagePreview: args.preview,
      unread: true,
    })}::jsonb`;
    // Provider coordinates are backfilled onto existing channels too (same
    // rationale as participantExternalId above — a channel born before the
    // bridge sent its guild id would otherwise never get a deep link). A plain
    // top-level `||` would REPLACE the whole `external` object and drop a
    // sibling key, so `external` is merged into its own prior value.
    const metadataExpr = externalPatch
      ? drizzleSql`jsonb_set(coalesce(${cacheMerge}, '{}'::jsonb), '{external}', coalesce(${channels.metadata}->'external', '{}'::jsonb) || ${JSON.stringify(
          externalPatch
        )}::jsonb)`
      : cacheMerge;
    await db
      .update(channels)
      .set({
        metadata: metadataExpr,
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
      // Cross-cutting project lens (independent of the workspace/pod axis).
      projectId: args.projectId ?? null,
      channelType: ChannelType.EXTERNAL,
      // Pod-wide when there's no workspace pin (Wave 3): a null workspace must be
      // a POD-scoped channel, not a WORKSPACE-scoped one with a null home.
      scope: args.workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
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
        // Provider-native coordinates (Discord guild id, Slack team id) — the
        // ids the channel-level deep link is built from. Omitted entirely when
        // the caller has none, so the stored shape is unchanged for them.
        ...(externalPatch ? { external: externalPatch } : {}),
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
    // ORIGIN AT BIRTH — `producer --produced--> channel` via the createLinks one
    // door. Only on a FRESH create: an origin is a fact about creation, and the
    // race loser below must not overwrite the winner's producer. Non-fatal.
    await recordChannelOrigin({
      channelId: inserted.id,
      workspaceId: args.workspaceId,
      origin: args.origin,
    });
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
  /**
   * Cross-cutting project lens for a freshly-created channel. `null`/absent =
   * not project-scoped. Independent of workspaceId (compose either/both/neither).
   */
  projectId?: string | null;
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
   * RFC reply-threading headers (email). Carried + stored under
   * `metadata.emailHeaders` so the SEND side can thread a reply by Message-Id /
   * In-Reply-To / References — prior art: thread by HEADERS, not subject. No
   * threading LOGIC here (carry-and-store only). Like attachments, these are
   * ADDITIVE METADATA and never part of the idempotency or tamper hash.
   */
  headerMessageId?: string;
  inReplyTo?: string;
  references?: string[];
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
  /**
   * WHO produced this channel — forwarded to `resolveOrCreateExternalChannel`
   * and written as a `produced` edge on a FRESH channel only. See
   * services/channels/channel-origin.ts for the producer-id convention.
   */
  origin?: ChannelOrigin;
  /**
   * Provider-native channel coordinates (Discord `guildId`, Slack `teamId`) →
   * `channels.metadata.external.*`. Feeds the channel-level deep link.
   */
  externalCoordinates?: { guildId?: string; teamId?: string };
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
    projectId: args.projectId ?? null,
    title: args.title,
    participant: args.participant,
    participantExternalId: args.participantExternalId,
    accountExternalId: args.accountExternalId,
    preview,
    lastMessageAt:
      typeof args.sentAt === "string" ? args.sentAt : sentAt.toISOString(),
    origin: args.origin,
    externalCoordinates: args.externalCoordinates,
  });

  // Dual-use note: this is an inbound *delivery* fingerprint
  // (sha256(provider:seed)), NOT computeMessageHash(id, content). Both live in
  // messages.hash; global UNIQUE (0218) makes the insert below race-safe for
  // both domains (tamper hashes include UUID id so they never collide with
  // intentional inbound seeds in practice).
  const inboundHash = createHash("sha256")
    .update(`${args.provider}:${args.idempotencySeed}`)
    .digest("hex");

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

  // RFC reply-threading headers (carry-and-store; see RecordInboundMessageArgs).
  const rfcHeaders =
    args.headerMessageId || args.inReplyTo || args.references?.length
      ? {
          ...(args.headerMessageId ? { messageId: args.headerMessageId } : {}),
          ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
          ...(args.references?.length ? { references: args.references } : {}),
        }
      : undefined;

  // Race-safe claim: UNIQUE(messages.hash) + ON CONFLICT DO NOTHING is the
  // concurrency boundary. Loser re-SELECTs and reports recorded:false so
  // callers skip a second IS turn / side-effect fan-out.
  const [inserted] = await db
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
      ...(senderMetadata ||
      args.attachments?.length ||
      rfcHeaders ||
      args.messageId
        ? {
            metadata: {
              ...(senderMetadata ? { sender: senderMetadata } : {}),
              // The provider's NATIVE message id, stored so a message can later
              // be pinned/permalinked back to its source. ADDITIVE METADATA:
              // `computeMessageHash` (@synap/database) hashes id + content only
              // — metadata is NOT in the tamper-hash preimage — and the
              // idempotency hash is sha256(provider:idempotencySeed), so this
              // touches NEITHER chain.
              ...(args.messageId ? { externalMessageId: args.messageId } : {}),
              ...(args.attachments?.length
                ? {
                    attachments: args.attachments
                      .slice(0, 4)
                      .map((a) => ({ type: a.type, url: a.url })),
                  }
                : {}),
              ...(rfcHeaders ? { emailHeaders: rfcHeaders } : {}),
            } as (typeof messages.$inferInsert)["metadata"],
          }
        : {}),
    })
    .onConflictDoNothing({ target: messages.hash })
    .returning({ id: messages.id });

  if (!inserted) {
    // Lost the race or exact replay — hash already claimed.
    const existing = await db.query.messages.findFirst({
      where: eq(messages.hash, inboundHash),
      columns: { id: true },
    });
    if (!existing) {
      throw new Error(
        `inbound-recorder: hash conflict for ${args.provider} but no row found on reselect`
      );
    }
    return { channelId, contextObjectId, inboundHash, recorded: false };
  }

  logger.info(
    { channelId, provider: args.provider, externalId: args.externalId },
    "Inbound message stored"
  );

  // Live search index — enqueue the SAME per-row `search-index` job the entity/
  // document reactors use (collection "messages" resolves the row by
  // messages.id). Cross-cutting: this makes EVERY inbound channel's messages
  // searchable, not just email — nothing enqueued a live message index before.
  // Runs regardless of suppressSideEffects: an index is a store, not a fan-out
  // replay — a historical backfill must still be searchable. Non-fatal.
  try {
    await getBoss().send("search-index", {
      collection: "messages",
      operation: "upsert",
      documentId: inserted.id,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.warn({ err, channelId }, "search-index enqueue failed (non-fatal)");
  }

  // Attachment ingest OFF the sensor path: fetch each attachment's bytes and
  // store it through the GOVERNED file door in a background job, then link the
  // resulting `file` entity to this channel + message. Never blocks the insert;
  // the {type,url} preview already lives on the message metadata (out of the
  // idempotency/tamper hash). Also a store, so it runs for backfill too. Non-fatal.
  if (args.attachments?.length) {
    try {
      await getBoss().send(INBOUND_ATTACHMENT_QUEUE, {
        channelId,
        messageId: inserted.id,
        userId: args.userId,
        workspaceId: args.workspaceId,
        provider: args.provider,
        attachments: args.attachments.slice(0, 8),
      } satisfies InboundAttachmentJobData);
    } catch (err) {
      logger.warn(
        { err, channelId },
        "inbound-attachment enqueue failed (non-fatal)"
      );
    }
  }

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
