/**
 * Measure one person's LinkedIn reach now, on demand (Hub
 * `POST /channels/linkedin-reach/:personId`, finding 491ba787).
 *
 * Why a door: the capability verb `linkedin_get_profile` is a bare HTTP call,
 * so on 5 Nov the founder ran it for a person, LinkedIn answered FIRST_DEGREE
 * and a member id, and nothing landed on the person. The reach facts were
 * written only by a send's reach check, the `relation.new` webhook and the
 * daily sweep (`services/connectors/linkedin-reach.ts`).
 *
 * One profile read with the owner's connected LinkedIn account, spent from
 * that account's daily lookup budget (`takeProfileLookup`), then:
 *   - `linkedinProviderId` filled when none is stored, and `linkedin:<id>`
 *     registered as the person's external id signal (`recordProviderId`);
 *   - the reach fact through the one rule (`linkedinReachFromProfile`,
 *     `recordLinkedinReach`): FIRST_DEGREE is connected (which releases held
 *     sends), a pending request is pending. A profile that only says "not
 *     connected" keeps a stored fact (a sent request the cheap read does not
 *     show stays pending; the sweep owns pending and ignored), and is stored
 *     as `none` only when nothing was.
 *
 * Machine-written system facts and a provider read, like the sweep: no
 * proposal per person. A failed read (no budget, LinkedIn or Unipile down)
 * writes nothing and is answered as what it is, never as "not connected".
 */

import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  type LinkedinConnection,
} from "@synap/database";
import { entities, messagingAccounts } from "@synap/database/schema";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { getMessagingConnector } from "../../connectors/index.js";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";
import { linkedinSlug } from "../capabilities/intent-recipient.js";
import {
  fillLinkedinProviderId,
  linkedinReachFromProfile,
  recordLinkedinReach,
  storedLinkedinReach,
} from "../connectors/linkedin-reach.js";
import {
  recordProviderId,
  storedProviderId,
  takeProfileLookup,
} from "../connectors/participant-lookup.js";

export type LinkedinReachReadResult =
  | {
      status: "measured";
      /** The reach stored after the read (null: LinkedIn said nothing). */
      reach: LinkedinConnection | null;
      invitedAt: string | null;
      /** LinkedIn's member id for the person. */
      providerId: string;
    }
  /** No person the caller reads. */
  | { status: "not_found" }
  /** The person is someone else's: their owner's account measures reach. */
  | { status: "not_owner" }
  /** No messaging service that reads LinkedIn profiles. */
  | { status: "unconfigured" }
  /** No connected LinkedIn account, or two (the pod does not guess). */
  | { status: "no_account"; accounts: number }
  /** Nothing to look them up by (no id, no profile URL). */
  | { status: "no_identifier" }
  /** Today's profile lookups of the account are spent. */
  | { status: "no_budget" }
  /** LinkedIn has no such member (404). */
  | { status: "not_on_linkedin" }
  /** The read failed: nothing written. */
  | { status: "failed"; error: string };

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export async function readLinkedinReach(args: {
  userId: string;
  personId: string;
  /** Tests: the connector (default: the pod's LinkedIn one). */
  connector?: MessagingConnector | null;
  now?: Date;
}): Promise<LinkedinReachReadResult> {
  const { userId, personId } = args;
  const now = args.now ?? new Date();

  // The person, on the caller's read floor (the key's grant ANDed). Reach is
  // a property of the system `person` kind: any other kind is not found.
  const [person] = await db
    .select({
      id: entities.id,
      type: entities.type,
      userId: entities.userId,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, personId),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  if (!person || person.type !== "person") return { status: "not_found" };
  if (person.userId !== userId) return { status: "not_owner" };
  const props = (person.properties ?? {}) as Record<string, unknown>;

  const connector =
    args.connector !== undefined
      ? args.connector
      : await getMessagingConnector("linkedin");
  if (!connector?.getProfile) return { status: "unconfigured" };

  const accounts = await db
    .select({
      id: messagingAccounts.id,
      externalId: messagingAccounts.externalId,
    })
    .from(messagingAccounts)
    .where(
      and(
        eq(messagingAccounts.userId, userId),
        drizzleSql`lower(${messagingAccounts.provider}) = 'linkedin'`,
        eq(messagingAccounts.status, "connected")
      )
    )
    .limit(2);
  if (accounts.length !== 1) {
    return { status: "no_account", accounts: accounts.length };
  }
  const account = accounts[0]!;

  const lookup =
    (await storedProviderId(person.id, "linkedin", props)) ??
    text(props.publicIdentifier) ??
    linkedinSlug(props.linkedinUrl);
  if (!lookup) return { status: "no_identifier" };

  if (!(await takeProfileLookup(account.id, now))) {
    return { status: "no_budget" };
  }

  let profile: Awaited<
    ReturnType<NonNullable<MessagingConnector["getProfile"]>>
  >;
  try {
    profile = await connector.getProfile(account.externalId, lookup);
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!profile) return { status: "not_on_linkedin" };

  await fillLinkedinProviderId(person.id, profile.providerId);
  await recordProviderId({
    entityId: person.id,
    userId,
    provider: "linkedin",
    providerId: profile.providerId,
  });

  const stored = storedLinkedinReach(props);
  const fact = linkedinReachFromProfile(profile);
  // "Not connected" never overrides a stored fact (module doc); a kept one
  // still goes through the 21-day rule.
  const incoming =
    fact && !(fact.connection === "none" && stored)
      ? fact
      : stored
        ? { connection: stored.connection, invitedAt: null }
        : null;
  const recorded = incoming
    ? await recordLinkedinReach(person.id, incoming, now)
    : null;
  return {
    status: "measured",
    reach: recorded?.connection ?? null,
    invitedAt: recorded?.invitedAt ?? null,
    providerId: profile.providerId,
  };
}
