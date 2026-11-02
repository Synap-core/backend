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
  desc,
  ne,
  lte,
  isNull,
  isNotNull,
  drizzleSql,
  channels,
  entities,
  messages,
  ChannelType,
  ChannelScope,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  MessageDirection,
  MessageDeliveryStatus,
} from "@synap/database";
import { emitSideEffects, getBoss } from "@synap/events";
import { resolveIdentity } from "@synap/database";
import {
  INBOUND_ATTACHMENT_QUEUE,
  type InboundAttachmentJobData,
} from "@synap/jobs/workers/inbound-attachment-worker.js";
import {
  MESSAGING_HISTORY_IMPORT_QUEUE,
  type MessagingHistoryImportJobData,
} from "@synap/jobs/workers/messaging-sync.js";
import { resolveExistingExternalUser } from "../external-user-mapping.js";
import { emitMessageObservation } from "../../utils/emit-message-observation.js";
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
  // The KIND of the bound context object — `contextObjectId` can point at a
  // document/view/proposal, not only an entity (see channels/helpers.ts
  // CONTEXT_OBJECT_TYPE_VALUES). Carried so callers can stay honest about what
  // the id names (e.g. only label it `entityId` when this is "entity").
  contextObjectType: string | null;
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
      contextObjectType: true,
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
        contextObjectType: row.contextObjectType,
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
  /**
   * The person this conversation is with, when the caller already knows them
   * (an email sender's strong match, a provider id the lookup resolved). A new
   * channel is born bound to them; an existing UNBOUND one is bound now. A
   * channel already bound to someone is never re-bound here.
   */
  contextEntityId?: string | null;
  /**
   * The outcome of the one profile lookup for this chat's participant
   * (participant-lookup.ts), cached as `metadata.participantLookup` so a later
   * message never repeats it.
   */
  participantLookup?: ParticipantLookupRecord;
}

/** `channels.metadata.participantLookup` — one lookup per chat, never two. */
export interface ParticipantLookupRecord {
  at: string;
  /**
   * matched / no-match / not-found are final; no-budget and failed let a later
   * message try again.
   */
  result: "matched" | "no-match" | "not-found" | "no-budget" | "failed";
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
): Promise<{
  channelId: string;
  contextObjectId: string | null;
  contextObjectType: string | null;
}> {
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
      ...(args.participantLookup
        ? { participantLookup: args.participantLookup }
        : {}),
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
    if (!existing.contextObjectId && args.contextEntityId) {
      const bound = await bindChannelToEntity(
        existing.id,
        args.contextEntityId
      );
      if (bound) {
        return {
          channelId: existing.id,
          contextObjectId: args.contextEntityId,
          contextObjectType: "entity",
        };
      }
    }
    return {
      channelId: existing.id,
      contextObjectId: existing.contextObjectId,
      contextObjectType: existing.contextObjectType,
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
  if (args.contextEntityId) {
    const person = await liveEntity(args.contextEntityId);
    if (person) {
      bornContextObjectId = person.id;
      bornContextObjectType = "entity";
      if (person.title) titleAtBirth = person.title;
    }
  }
  if (!bornContextObjectId && args.participantExternalId) {
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

  // ADOPT the person's PENDING channel (opened before the provider gave a chat
  // id: a lead's first draft, openPersonChannel) instead of creating a twin.
  // Race-safe with the executor that starts the chat: the UPDATE only lands
  // while `external_id IS NULL`, and losing it to the unique index (the same
  // chat already has a channel) falls through to the re-select below.
  if (bornContextObjectId) {
    const adopted = await adoptPendingChannel({
      userId: args.userId,
      provider: args.provider,
      entityId: bornContextObjectId,
      accountExternalId: args.accountExternalId,
      externalId: args.externalId,
      metadataPatch: {
        ...(args.participant ? { participantName: args.participant } : {}),
        ...(args.participantExternalId
          ? { participantExternalId: args.participantExternalId }
          : {}),
        ...(args.accountExternalId
          ? { accountId: args.accountExternalId }
          : {}),
        lastMessageAt,
        lastMessagePreview: args.preview,
        unread: true,
        ...(args.participantLookup
          ? { participantLookup: args.participantLookup }
          : {}),
      },
    });
    if (adopted) {
      logger.info(
        {
          channelId: adopted,
          provider: args.provider,
          externalId: args.externalId,
          linkedEntityId: bornContextObjectId,
        },
        "Adopted the person's pending EXTERNAL channel for this chat"
      );
      return {
        channelId: adopted,
        contextObjectId: bornContextObjectId,
        contextObjectType: "entity",
      };
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
        ...(args.participantLookup
          ? { participantLookup: args.participantLookup }
          : {}),
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
    return {
      channelId: inserted.id,
      contextObjectId: bornContextObjectId,
      contextObjectType: bornContextObjectType,
    };
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
  return {
    channelId: survivor.id,
    contextObjectId: survivor.contextObjectId,
    contextObjectType: survivor.contextObjectType,
  };
}

/** A live (not deleted) entity's id + title, or null. */
async function liveEntity(
  entityId: string
): Promise<{ id: string; title: string | null } | null> {
  const row = await db.query.entities.findFirst({
    where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
    columns: { id: true, title: true },
  });
  return row ?? null;
}

/**
 * Bind an UNBOUND channel to a person and title it after them. Only while it
 * is still unbound (`context_object_id IS NULL`): a channel someone already
 * bound is never moved by an inbound message. True when it bound.
 */
async function bindChannelToEntity(
  channelId: string,
  entityId: string
): Promise<boolean> {
  const person = await liveEntity(entityId);
  if (!person) return false;
  const rows = await db
    .update(channels)
    .set({
      contextObjectType: "entity",
      contextObjectId: person.id,
      ...(person.title ? { title: person.title } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(channels.id, channelId), isNull(channels.contextObjectId)))
    .returning({ id: channels.id });
  return rows.length > 0;
}

/** Postgres unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Give the person's pending channel its provider chat id. The pending channel
 * is the one `openPersonChannel` made: EXTERNAL, active, no `external_id`,
 * bound to the person, same provider, and the same account (or none named).
 * Returns the adopted channel id, or null when there is none to adopt or the
 * chat already has a channel (lost the race to the unique index).
 */
async function adoptPendingChannel(args: {
  userId: string;
  provider: string;
  entityId: string;
  accountExternalId?: string;
  externalId: string;
  metadataPatch: Record<string, unknown>;
}): Promise<string | null> {
  const account = args.accountExternalId ?? "";
  const [pending] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, args.userId),
        eq(channels.channelType, ChannelType.EXTERNAL),
        eq(channels.externalSource, args.provider),
        eq(channels.contextObjectId, args.entityId),
        eq(channels.status, "active"),
        isNull(channels.externalId),
        drizzleSql`COALESCE(${channels.metadata} ->> 'accountId', '') IN (${account}, '')`
      )
    )
    // The pending channel on this very account first, then one with none.
    .orderBy(
      desc(
        drizzleSql`(COALESCE(${channels.metadata} ->> 'accountId', '') = ${account})`
      ),
      asc(channels.createdAt)
    )
    .limit(1);
  if (!pending) return null;
  try {
    const rows = await db
      .update(channels)
      .set({
        externalId: args.externalId,
        externalChannelId: args.externalId,
        metadata: drizzleSql`COALESCE(${channels.metadata}, '{}'::jsonb) || ${JSON.stringify(
          args.metadataPatch
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(channels.id, pending.id), isNull(channels.externalId)))
      .returning({ id: channels.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// ── A person's channel, before the first message ───────────────────────────────

export interface OpenPersonChannelArgs {
  /** The pod owner the channel belongs to. */
  userId: string;
  /** The person (or company) the conversation is with. */
  entityId: string;
  /** Provider slug, as the connector reports it (`linkedin`, `instagram`…). */
  provider: string;
  /** The messaging account's provider id (`messaging_accounts.external_id`). */
  accountId?: string | null;
  /** The person's id on the provider, when known (the send's attendee). */
  participantExternalId?: string | null;
  /** Workspace pin; `null`/absent = pod-level (the channel follows its person). */
  workspaceId?: string | null;
}

export interface OpenPersonChannelResult {
  channelId: string;
  /** The provider chat id, or null while the channel is pending. */
  externalId: string | null;
  /** True when this call made the pending channel. */
  created: boolean;
}

/**
 * The person's channel on a tool and account, made if it does not exist yet
 * (founder decision 2: a lead's channel exists from the first draft). Returns
 * the person's existing channel there (one with a chat id first), else their
 * PENDING one, else makes a pending one: EXTERNAL, `external_id` NULL, bound to
 * the person, `metadata.accountId`. Idempotent under a race through the
 * one-pending-channel index (0393). The first inbound or sent message on the
 * chat fills its chat id (`adoptPendingChannel`).
 *
 * A new channel also asks for the person's history on that account (silent
 * import, design §7). Lane D's send executor calls this for a lead with no
 * chat yet.
 */
export async function openPersonChannel(
  args: OpenPersonChannelArgs
): Promise<OpenPersonChannelResult> {
  const account = args.accountId ?? "";
  const accountMatch = account
    ? drizzleSql`COALESCE(${channels.metadata} ->> 'accountId', '') = ${account}`
    : drizzleSql`true`;
  const findExisting = async () => {
    const [row] = await db
      .select({ id: channels.id, externalId: channels.externalId })
      .from(channels)
      .where(
        and(
          eq(channels.userId, args.userId),
          eq(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.externalSource, args.provider),
          eq(channels.contextObjectType, "entity"),
          eq(channels.contextObjectId, args.entityId),
          eq(channels.status, "active"),
          accountMatch
        )
      )
      // A real chat before a pending one; the most recently used first.
      .orderBy(
        desc(drizzleSql`(${channels.externalId} IS NOT NULL)`),
        desc(channels.updatedAt)
      )
      .limit(1);
    return row ?? null;
  };

  const existing = await findExisting();
  if (existing) {
    return {
      channelId: existing.id,
      externalId: existing.externalId,
      created: false,
    };
  }

  const person = await liveEntity(args.entityId);
  if (!person) {
    throw new Error(
      `openPersonChannel: entity ${args.entityId} does not exist or was deleted`
    );
  }

  const workspaceId = args.workspaceId ?? null;
  const [inserted] = await db
    .insert(channels)
    .values({
      userId: args.userId,
      workspaceId,
      channelType: ChannelType.EXTERNAL,
      scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
      title: person.title ?? args.provider,
      contextObjectType: "entity",
      contextObjectId: person.id,
      externalSource: args.provider,
      externalChannelId: null,
      externalId: null,
      metadata: {
        ...(account ? { accountId: account } : {}),
        ...(person.title ? { participantName: person.title } : {}),
        ...(args.participantExternalId
          ? { participantExternalId: args.participantExternalId }
          : {}),
      },
    })
    // The one-pending-channel index (0393) is an expression index, so the
    // arbiter is left implicit: a concurrent open collapses onto one row.
    .onConflictDoNothing()
    .returning({ id: channels.id });

  if (!inserted) {
    const survivor = await findExisting();
    if (!survivor) {
      throw new Error(
        `openPersonChannel: conflict for ${args.provider}:${args.entityId} but no channel found on re-select`
      );
    }
    return {
      channelId: survivor.id,
      externalId: survivor.externalId,
      created: false,
    };
  }

  // The person's history on that account, silently (non-fatal: the channel
  // is open whether or not the import could be asked for).
  if (account) {
    try {
      await getBoss().send(
        MESSAGING_HISTORY_IMPORT_QUEUE,
        {
          accountExternalId: account,
          userId: args.userId,
          entityId: person.id,
        } satisfies MessagingHistoryImportJobData,
        { singletonKey: `${account}:${person.id}` }
      );
    } catch (err) {
      logger.warn(
        { err, channelId: inserted.id },
        "openPersonChannel: history import enqueue failed (non-fatal)"
      );
    }
  }

  return { channelId: inserted.id, externalId: null, created: true };
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
   * Unipile uses `${chatId}:${messageId}` (the webhook and the history import
   * alike, so a message both see lands once); Discord uses the gateway
   * message id.
   */
  idempotencySeed: string;
  /**
   * Which way the message went. `inbound` (default) = the person sent it;
   * `outbound` = the account owner sent it (from the provider's own app, or
   * the provider's echo of a send the pod made). An outbound row is HUMAN /
   * ASSISTANT with `delivery_status` 'sent', and fires `external_message.sent`
   * (source 'provider'), never `external_message.received`.
   */
  direction?: MessageDirection;
  /** See ResolveOrCreateExternalChannelArgs.contextEntityId. */
  contextEntityId?: string | null;
  /** See ResolveOrCreateExternalChannelArgs.participantLookup. */
  participantLookup?: ParticipantLookupRecord;
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
   * The native message id from the external provider (e.g. Discord snowflake,
   * Unipile message id). Stored as `messages.external_message_id`: one row per
   * provider message per channel (`messages_channel_ext_msg_uniq`), so the
   * provider's echo of a message the pod sent never doubles it. Surfaced in
   * the event data so automations can read `{{trigger.payload.data.messageId}}`.
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
 * Resolve-or-create the EXTERNAL channel, dedup-insert the message with its
 * direction, and emit `external_message.received` (inbound; with `isReply`,
 * `repliesToMessageId`, `lastOutboundAt` when the channel had an outbound
 * message before it) or `external_message.sent` (outbound, source
 * 'provider').
 *
 * Idempotent: a duplicate delivery (same provider + idempotencySeed), or a
 * provider message already in the channel (same external message id), does
 * not re-insert and returns `recorded: false`, so callers can skip duplicate
 * work (e.g. a second IS turn). The automation event only fires on a fresh
 * record.
 */
export async function recordInboundMessage(
  args: RecordInboundMessageArgs
): Promise<RecordInboundMessageResult> {
  const preview = args.text.slice(0, 120);
  const sentAt = args.sentAt ? new Date(args.sentAt) : new Date();
  const direction = args.direction ?? MessageDirection.INBOUND;
  const outbound = direction === MessageDirection.OUTBOUND;
  const externalMessageId = args.messageId?.trim() || null;

  const { channelId, contextObjectId, contextObjectType } =
    await resolveOrCreateExternalChannel({
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
      ...(args.contextEntityId !== undefined
        ? { contextEntityId: args.contextEntityId }
        : {}),
      ...(args.participantLookup
        ? { participantLookup: args.participantLookup }
        : {}),
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

  // Race-safe claim: TWO unique indexes are the concurrency boundary —
  // UNIQUE(messages.hash) (the same delivery twice) and (channel_id,
  // external_message_id) (the same provider message through another path:
  // the history import, or the echo of a message the pod sent). ON CONFLICT DO
  // NOTHING with no target covers both. The loser re-SELECTs and reports
  // recorded:false so callers skip a second IS turn / side-effect fan-out.
  const authorType =
    args.authorType ??
    (outbound ? MessageAuthorType.HUMAN : MessageAuthorType.EXTERNAL);
  const [inserted] = await db
    .insert(messages)
    .values({
      channelId,
      userId: args.userId,
      // Inbound = EXTERNAL/USER; outbound = the operator's own message,
      // HUMAN/ASSISTANT, so the inbox attributes it to them.
      role: args.role ?? (outbound ? MessageRole.ASSISTANT : MessageRole.USER),
      authorType,
      messageCategory: MessageCategory.CHAT,
      externalSource: args.provider,
      content: args.text,
      hash: inboundHash,
      timestamp: sentAt,
      direction,
      deliveryStatus: outbound ? MessageDeliveryStatus.SENT : null,
      externalMessageId,
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
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (!inserted) {
    // Lost the race, an exact replay, or this provider message is already in
    // the channel (import, or the echo of our own send).
    const existing =
      (await db.query.messages.findFirst({
        where: eq(messages.hash, inboundHash),
        columns: { id: true },
      })) ??
      (externalMessageId
        ? await db.query.messages.findFirst({
            where: and(
              eq(messages.channelId, channelId),
              eq(messages.externalMessageId, externalMessageId)
            ),
            columns: { id: true },
          })
        : undefined);
    if (!existing) {
      throw new Error(
        `inbound-recorder: conflict for ${args.provider} but no row found on reselect`
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

  // Keystone fact write: append `message.received` to the `events` log
  // alongside the `messages` insert above, so analyzers can read the log and
  // replay over history — today an inbound message wrote ONLY to `messages`.
  // Guarded on `inserted` (this branch only runs when a NEW row landed, i.e.
  // NOT on an idempotent-conflict re-delivery — see the `if (!inserted)`
  // early-return above). Runs regardless of `suppressSideEffects`, same as
  // `search-index` above: this is a STORE of a fact (including for a
  // historical backfill), not a fan-out replay. Points at the real channel
  // (+ the bound entity, when linked) — never copies the message body.
  await emitMessageObservation({
    type: outbound ? "message.sent" : "message.received",
    userId: args.userId,
    channelId,
    messageId: inserted.id,
    workspaceId: args.workspaceId,
    // Only label the bound object an `entityId` when it actually IS an entity —
    // an EXTERNAL channel can later be rebound to a document/view/proposal via
    // channel.bind/updateChannel, and `contextObjectId` would then name one of
    // those. Mirrors the outbound guard in channels/send-message.ts.
    entityId: contextObjectType === "entity" ? contextObjectId : undefined,
    // The message's REAL time, not now — so a historical backfill
    // (channel.ingest, ≤2000 msgs) stamps each fact with when it actually
    // happened, which is the whole point of a replayable-over-history log.
    timestamp: sentAt,
    data: {
      authorType,
      direction,
      externalSource: args.provider,
      threadId: args.externalId,
    },
  });

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

  const entityId = contextObjectType === "entity" ? contextObjectId : undefined;
  // The latest OUTBOUND message before this one: an inbound after it is a
  // reply; an outbound with none before it is the first contact.
  const lastOutbound = await db.query.messages.findFirst({
    where: and(
      eq(messages.channelId, channelId),
      eq(messages.direction, MessageDirection.OUTBOUND),
      lte(messages.timestamp, sentAt),
      ne(messages.id, inserted.id)
    ),
    columns: { id: true, timestamp: true },
    orderBy: [desc(messages.timestamp), desc(messages.id)],
  });

  if (outbound) {
    // The owner's own message, seen through the provider (sent from their
    // phone, or the provider's copy of a send the pod made before the
    // executor recorded it). Never `received`: an auto-reply rule must not
    // answer our own message.
    await emitSideEffects({
      subjectType: "external_message",
      action: "sent",
      subjectId: (contextObjectId ?? channelId) as string,
      userId: args.userId,
      workspaceId: args.workspaceId,
      data: {
        entityId,
        channelId,
        provider: args.provider,
        threadId: args.externalId,
        messageId: args.messageId,
        source: "provider",
        first: !lastOutbound,
        messagePreview: preview,
        content: args.text.slice(0, 4000),
      },
    }).catch((err) => {
      logger.warn({ err, channelId }, "emitSideEffects failed (non-fatal)");
    });
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
      // Same guard as the observation log above (and the outbound one in
      // channels/send-message.ts): an EXTERNAL channel's `contextObjectId` may
      // name a document/view/proposal, so only label it `entityId` when it IS
      // an entity. `deriveMessageEnvelope` and `deriveEventSubjectEntityId`
      // both read this key as an entity id — an unguarded document id made a
      // rule's entity filter match a non-entity.
      entityId,
      channelId,
      provider: args.provider,
      threadId: args.externalId,
      messageId: args.messageId,
      participantName: args.participant,
      // A reply: the channel had an outbound message before this one.
      ...(lastOutbound
        ? {
            isReply: true,
            repliesToMessageId: lastOutbound.id,
            lastOutboundAt: lastOutbound.timestamp.toISOString(),
          }
        : {}),
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

// ── Delivery status (provider receipts) ────────────────────────────────────────

/** Which statuses each receipt may move an outbound message FROM. */
const DELIVERY_STATUS_FROM: Record<"delivered" | "read", string[]> = {
  delivered: [MessageDeliveryStatus.SENT],
  read: [MessageDeliveryStatus.SENT, MessageDeliveryStatus.DELIVERED],
};

/**
 * Move an outbound message's `delivery_status` FORWARD on a provider receipt
 * (sent → delivered → read), found by its provider message id in the account
 * owner's channel for that chat. Never backwards, never out of `failed`, never
 * on an inbound row. Returns how many rows moved (0 = unknown message, or the
 * receipt is stale).
 */
export async function advanceDeliveryStatus(args: {
  provider: string;
  userId: string;
  threadId: string;
  externalMessageId: string;
  status: "delivered" | "read";
}): Promise<number> {
  const from = DELIVERY_STATUS_FROM[args.status];
  const rows = await db
    .update(messages)
    .set({ deliveryStatus: args.status })
    .where(
      and(
        eq(messages.externalMessageId, args.externalMessageId),
        eq(messages.direction, MessageDirection.OUTBOUND),
        drizzleSql`(${messages.deliveryStatus} IS NULL OR ${messages.deliveryStatus} IN (${drizzleSql.join(
          from.map((f) => drizzleSql`${f}`),
          drizzleSql`, `
        )}))`,
        drizzleSql`${messages.channelId} IN (
          SELECT ${channels.id} FROM ${channels}
           WHERE ${channels.userId} = ${args.userId}
             AND ${channels.channelType} = ${ChannelType.EXTERNAL}
             AND ${channels.externalSource} = ${args.provider}
             AND ${channels.externalId} = ${args.threadId})`
      )
    )
    .returning({ id: messages.id });
  return rows.length;
}
