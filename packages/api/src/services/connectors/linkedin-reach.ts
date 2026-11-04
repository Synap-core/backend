/**
 * Whether the pod's LinkedIn account can reach a person (CRM wave 2, S4a,
 * build map 6f6c197f): `linkedinConnection` (none | pending | connected |
 * ignored) and `linkedinInvitedAt` (ISO date) on the person.
 *
 * ONE rule, three writers, all server code:
 *   - the reach check of a send (`readChannelReach`, at filing and at
 *     dispatch), from the profile it reads;
 *   - the `relation.new` webhook (a request was accepted): connected;
 *   - the daily sweep (`runLinkedinReachSweep`): each sent request still
 *     waiting is pending with its date, and a request pending for more than
 *     21 days is ignored.
 * Agents never write these fields: the system `person` kind declares them
 * machine-written (read-only in every editor).
 *
 * NO `entity.update` EMIT, on purpose (the `noteInteraction` reasoning): a
 * reach fact synced from LinkedIn is not an edit. Through the update door
 * every sweep would re-embed the person, reindex search and fire automations.
 * `updated_at` and `version` are left alone for the same reason.
 *
 * A failed read is never a fact: the callers write only what a provider
 * answer said; an error writes nothing.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  LINKEDIN_CONNECTION_VALUES,
  type LinkedinConnection,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import type { MessagingProfile } from "../../connectors/MessagingConnector.js";

const logger = createLogger({ module: "linkedin-reach" });

export const LINKEDIN_CONNECTION_PROPERTY = "linkedinConnection";
export const LINKEDIN_INVITED_AT_PROPERTY = "linkedinInvitedAt";

export { LINKEDIN_CONNECTION_VALUES, type LinkedinConnection };

/** A request still pending this long is read as ignored. */
export const INVITATION_IGNORED_AFTER_DAYS = 21;
const IGNORED_AFTER_MS = INVITATION_IGNORED_AFTER_DAYS * 24 * 60 * 60 * 1000;

/** What the pod knows of a person's reach. `invitedAt` null = not known. */
export interface LinkedinReachFact {
  connection: LinkedinConnection;
  invitedAt: string | null;
}

/** An ISO date (or datetime) string → its ISO form; anything else → null. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * THE 21-day rule: a request pending for more than 21 days is ignored. A
 * pending request with no known date stays pending (no date, no age).
 */
export function settleLinkedinReach(
  fact: LinkedinReachFact,
  now: Date = new Date()
): LinkedinReachFact {
  if (fact.connection !== "pending" || !fact.invitedAt) return fact;
  const sent = Date.parse(fact.invitedAt);
  if (Number.isNaN(sent)) return fact;
  return now.getTime() - sent > IGNORED_AFTER_MS
    ? { ...fact, connection: "ignored" }
    : fact;
}

/**
 * What a LinkedIn profile answer says of reach, or null when it says nothing
 * (no distance, no request: not measured, never "none").
 */
export function linkedinReachFromProfile(
  profile: Pick<MessagingProfile, "connection" | "relationRequest">
): LinkedinReachFact | null {
  const request = profile.relationRequest ?? null;
  const sentAt =
    request && request.direction !== "received"
      ? isoOrNull(request.sentAt)
      : null;
  switch (profile.connection) {
    case "connected":
      return { connection: "connected", invitedAt: null };
    case "pending":
      return { connection: "pending", invitedAt: sentAt };
    case "not_connected":
      // LinkedIn itself may say the owner's request was ignored.
      return request?.status === "ignored" && request.direction !== "received"
        ? { connection: "ignored", invitedAt: sentAt }
        : { connection: "none", invitedAt: null };
    default:
      return null;
  }
}

/** The fact stored on a person's properties, or null when none is. */
export function storedLinkedinReach(
  properties: Record<string, unknown> | null | undefined
): LinkedinReachFact | null {
  const raw = properties?.[LINKEDIN_CONNECTION_PROPERTY];
  if (
    typeof raw !== "string" ||
    !(LINKEDIN_CONNECTION_VALUES as readonly string[]).includes(raw)
  ) {
    return null;
  }
  return {
    connection: raw as LinkedinConnection,
    invitedAt: isoOrNull(properties?.[LINKEDIN_INVITED_AT_PROPERTY]),
  };
}

/**
 * The fact to store: the new one, keeping the stored date when the new one
 * names none (a profile read of a pending request without its date), then
 * the 21-day rule.
 */
export function nextLinkedinReach(
  stored: LinkedinReachFact | null,
  incoming: LinkedinReachFact,
  now: Date = new Date()
): LinkedinReachFact {
  const invitedAt = incoming.invitedAt ?? stored?.invitedAt ?? null;
  return settleLinkedinReach(
    { connection: incoming.connection, invitedAt },
    now
  );
}

/**
 * Write a person's reach fact (merged with what is stored, then the 21-day
 * rule). Only on a live `person`; a write that changes nothing writes
 * nothing. Returns the stored fact after the call, or null when there is no
 * such person. Throws only on a database failure.
 */
export async function recordLinkedinReach(
  entityId: string,
  incoming: LinkedinReachFact,
  now: Date = new Date()
): Promise<LinkedinReachFact | null> {
  const row = await db.query.entities.findFirst({
    where: and(
      eq(entities.id, entityId),
      eq(entities.type, "person"),
      isNull(entities.deletedAt)
    ),
    columns: { properties: true },
  });
  if (!row) return null;
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const stored = storedLinkedinReach(props);
  const next = nextLinkedinReach(stored, incoming, now);
  if (
    stored &&
    stored.connection === next.connection &&
    stored.invitedAt === next.invitedAt
  ) {
    return stored;
  }
  const patch: Record<string, string> = {
    [LINKEDIN_CONNECTION_PROPERTY]: next.connection,
  };
  if (next.invitedAt) patch[LINKEDIN_INVITED_AT_PROPERTY] = next.invitedAt;
  await db
    .update(entities)
    .set({
      properties: drizzleSql`coalesce(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(and(eq(entities.id, entityId), isNull(entities.deletedAt)));
  logger.debug(
    { entityId, from: stored?.connection ?? null, to: next.connection },
    "linkedin reach recorded"
  );
  return next;
}
