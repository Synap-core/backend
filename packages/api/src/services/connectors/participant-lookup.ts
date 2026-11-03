/**
 * Who is on the other side of a chat: the provider's id for the person,
 * resolved to a person already in the pod (channels design §2).
 *
 * In order, cheapest first:
 *   1. `external_id` `<provider>:<id>`: the id is already on a person
 *      (`linkedinProviderId`, registered by identity-resolution-service).
 *   2. The public handle the payload carries (LinkedIn profile slug) as the
 *      person's `linkedinUrl` (strong).
 *   3. ONE provider profile lookup (`connector.getProfile`), LinkedIn only,
 *      within the account's daily budget (`messaging_accounts.metadata.
 *      profileLookups {day, count}`, 80 a day): its public handle as
 *      `linkedinUrl`. The outcome is cached on the chat's channel
 *      (`metadata.participantLookup`) so a later message never repeats it.
 *
 * A match by handle registers the provider id as the person's external id
 * signal (step 1 next time); the person's properties are never written here. No match leaves the chat unbound: the
 * pod never creates a person for an unknown sender. Instagram resolves by
 * external id only (design §2).
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  channels,
  entities,
  entityIdentitySignals,
  messagingAccounts,
  ChannelType,
  resolveIdentity,
  registerIdentitySignals,
  providerExternalId,
  PROVIDER_ID_PROPERTY_KEYS,
} from "@synap/database";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";
import type { ParticipantLookupRecord } from "./inbound-recorder.js";

const logger = createLogger({ module: "participant-lookup" });

/** Profile lookups one messaging account may spend in a UTC day. */
export const PROFILE_LOOKUP_DAILY_CAP = 80;

/** Lookup outcomes that settle a chat: it is never looked up again. */
const FINAL_LOOKUPS: ReadonlySet<ParticipantLookupRecord["result"]> = new Set([
  "matched",
  "no-match",
  "not-found",
]);

/** The property that holds a provider's id for a person (`linkedinProviderId`). */
export function providerIdProperty(provider: string): string | null {
  const p = provider.trim().toLowerCase();
  for (const [key, name] of Object.entries(PROVIDER_ID_PROPERTY_KEYS)) {
    if (name === p) return key;
  }
  return null;
}

/** A LinkedIn profile slug → the profile URL a `linkedinUrl` holds. */
export function linkedinProfileUrl(publicIdentifier: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier.trim())}`;
}

/**
 * Spend one profile lookup from the account's daily budget. Atomic: the
 * UPDATE only lands while today's count is under the cap. False = no budget.
 */
export async function takeProfileLookup(
  accountRowId: string,
  now: Date = new Date()
): Promise<boolean> {
  const day = now.toISOString().slice(0, 10);
  const meta = drizzleSql`COALESCE(${messagingAccounts.metadata}, '{}'::jsonb)`;
  const rows = await db
    .update(messagingAccounts)
    .set({
      metadata: drizzleSql`jsonb_set(${meta}, '{profileLookups}', jsonb_build_object(
        'day', ${day}::text,
        'count', CASE WHEN ${meta} -> 'profileLookups' ->> 'day' = ${day}
                      THEN COALESCE((${meta} -> 'profileLookups' ->> 'count')::int, 0) + 1
                      ELSE 1 END))`,
    })
    .where(
      and(
        eq(messagingAccounts.id, accountRowId),
        drizzleSql`(COALESCE(${meta} -> 'profileLookups' ->> 'day', '') <> ${day}
          OR COALESCE((${meta} -> 'profileLookups' ->> 'count')::int, 0) < ${PROFILE_LOOKUP_DAILY_CAP})`
      )
    )
    .returning({ id: messagingAccounts.id });
  return rows.length > 0;
}

/**
 * Register `<provider>:<id>` as the person's external id, so the next message
 * from that id binds at once. An IDENTITY SIGNAL, never a property write: the
 * person's properties (and so their lifecycle projection) are only written
 * through the entity doors (`lifecycle-one-door` tripwire), and a rule must not
 * fire because the pod learned an id. The chat's channel keeps the id too
 * (`metadata.participantExternalId`), which is what the send side reads. Only
 * on a live person the account owner owns; a signal another person already
 * holds is never moved (`registerIdentitySignals` skips a taken pair).
 */
export async function recordProviderId(args: {
  entityId: string;
  userId: string;
  provider: string;
  providerId: string;
}): Promise<void> {
  const owned = await db.query.entities.findFirst({
    where: and(
      eq(entities.id, args.entityId),
      eq(entities.userId, args.userId),
      isNull(entities.deletedAt)
    ),
    columns: { id: true },
  });
  if (!owned) return;
  await registerIdentitySignals(
    db,
    args.entityId,
    [
      {
        type: "external_id",
        value: providerExternalId(args.provider, args.providerId),
      },
    ],
    "messaging.participant-lookup"
  );
}

/**
 * The provider's id for a person, as the pod knows it: their property
 * (`linkedinProviderId`, written by a person or a capture), else the external
 * id signal a lookup registered. `null` = not known.
 */
export async function storedProviderId(
  entityId: string,
  provider: string,
  properties: Record<string, unknown>
): Promise<string | null> {
  const key = providerIdProperty(provider);
  const fromProperty = key ? properties[key] : undefined;
  if (typeof fromProperty === "string" && fromProperty.trim()) {
    return fromProperty.trim();
  }
  const prefix = providerExternalId(provider, "");
  const row = await db.query.entityIdentitySignals.findFirst({
    where: and(
      eq(entityIdentitySignals.entityId, entityId),
      eq(entityIdentitySignals.signalType, "external_id"),
      drizzleSql`starts_with(${entityIdentitySignals.signalValue}, ${prefix})`
    ),
    columns: { signalValue: true },
  });
  return row ? row.signalValue.slice(prefix.length) || null : null;
}

export interface ResolveParticipantArgs {
  provider: string;
  /** The pod owner of the account. */
  userId: string;
  /** The messaging account (`messaging_accounts` row). */
  account: { id: string; externalId: string };
  /** The person's id on the provider (the sender, or the chat counterpart). */
  providerId: string;
  /** Their public handle, when the payload gives it. */
  publicIdentifier?: string | null;
  /** The chat id: its channel's cached lookup is read and honoured. */
  chatId?: string;
  connector: Pick<MessagingConnector, "getProfile">;
  /** False skips the paid lookup (step 3). Default true. */
  allowLookup?: boolean;
  now?: Date;
}

export interface ResolvedParticipant {
  /** The person this id belongs to, or null. */
  entityId: string | null;
  /** Set when a lookup was tried: cache it on the chat's channel. */
  lookup?: ParticipantLookupRecord;
}

async function strongMatch(
  userId: string,
  signal: { type: string; value: string }
): Promise<string | null> {
  const r = await resolveIdentity(db, { userId, signals: [signal] });
  return r.match === "strong" && r.entity ? r.entity.id : null;
}

/** The cached lookup on the chat's channel, when the channel exists. */
async function cachedLookup(
  provider: string,
  chatId: string | undefined
): Promise<ParticipantLookupRecord | null> {
  if (!chatId) return null;
  const row = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalSource, provider),
      eq(channels.externalId, chatId)
    ),
    columns: { metadata: true },
  });
  const rec = (row?.metadata as Record<string, unknown> | null | undefined)
    ?.participantLookup as ParticipantLookupRecord | undefined;
  return rec && typeof rec.result === "string" ? rec : null;
}

/** See the module doc. Never throws for a failed provider read. */
export async function resolveParticipant(
  args: ResolveParticipantArgs
): Promise<ResolvedParticipant> {
  const provider = args.provider.trim().toLowerCase();
  const providerId = args.providerId.trim();
  if (!providerId) return { entityId: null };

  // 1. The id is already on a person.
  const byId = await strongMatch(args.userId, {
    type: "external_id",
    value: providerExternalId(provider, providerId),
  });
  if (byId) return { entityId: byId };

  if (provider !== "linkedin") return { entityId: null };

  // 2. The handle the payload carries.
  if (args.publicIdentifier?.trim()) {
    const byHandle = await strongMatch(args.userId, {
      type: "linkedin_url",
      value: linkedinProfileUrl(args.publicIdentifier),
    });
    if (byHandle) {
      await recordProviderId({
        entityId: byHandle,
        userId: args.userId,
        provider,
        providerId,
      });
      return { entityId: byHandle };
    }
  }

  // 3. One lookup, within budget, never twice for a chat.
  if (args.allowLookup === false || !args.connector.getProfile) {
    return { entityId: null };
  }
  const cached = await cachedLookup(provider, args.chatId);
  if (cached && FINAL_LOOKUPS.has(cached.result)) return { entityId: null };

  const at = (args.now ?? new Date()).toISOString();
  if (!(await takeProfileLookup(args.account.id, args.now))) {
    return { entityId: null, lookup: { at, result: "no-budget" } };
  }
  let profile: Awaited<
    ReturnType<NonNullable<MessagingConnector["getProfile"]>>
  >;
  try {
    profile = await args.connector.getProfile(
      args.account.externalId,
      providerId
    );
  } catch (err) {
    logger.warn(
      { err, provider, accountId: args.account.externalId },
      "participant lookup failed (the chat stays unbound; a later message retries)"
    );
    return { entityId: null, lookup: { at, result: "failed" } };
  }
  if (!profile) return { entityId: null, lookup: { at, result: "not-found" } };
  if (!profile.publicIdentifier) {
    return { entityId: null, lookup: { at, result: "no-match" } };
  }
  const matched = await strongMatch(args.userId, {
    type: "linkedin_url",
    value: linkedinProfileUrl(profile.publicIdentifier),
  });
  if (!matched) return { entityId: null, lookup: { at, result: "no-match" } };
  await recordProviderId({
    entityId: matched,
    userId: args.userId,
    provider,
    providerId,
  });
  return { entityId: matched, lookup: { at, result: "matched" } };
}
