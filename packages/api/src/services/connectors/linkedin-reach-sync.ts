/**
 * The two writers of a person's LinkedIn reach that are not a send (the
 * rule and the write: `linkedin-reach.ts`).
 *
 *  - `recordAcceptedRelation`: Unipile's `relation.new` (a request was
 *    accepted, up to 6 h late) marks the person `connected`.
 *  - `runLinkedinReachSweep`: the daily `linkedin-reach-sweep` job reads the
 *    requests each connected LinkedIn account SENT and that still wait: each
 *    one's person is `pending` with its date; then every person still
 *    `pending` for more than 21 days is `ignored`.
 *
 * The person is found by the LinkedIn member id (the `external_id` signal
 * `linkedin:<id>` that `linkedinProviderId` registers), else by the profile
 * handle as their `linkedinUrl` (`resolveParticipant`, no paid lookup). The
 * pod never creates a person here.
 *
 * A failed read writes nothing: an account whose list cannot be read keeps
 * its people as they were (the 21-day rule still runs: it reads only what is
 * stored).
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, isNull, drizzleSql } from "@synap/database";
import { entities, messagingAccounts } from "@synap/database/schema";
import { getMessagingConnector } from "../../connectors/index.js";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";
import { resolveParticipant } from "./participant-lookup.js";
import {
  LINKEDIN_CONNECTION_PROPERTY,
  recordLinkedinReach,
} from "./linkedin-reach.js";

const logger = createLogger({ module: "linkedin-reach-sync" });

/** Never walk more pages of sent requests than this for one account. */
const MAX_INVITATION_PAGES = 20;

/** The person a LinkedIn member is, in the account owner's pod, or null. */
async function personOf(args: {
  userId: string;
  account: { id: string; externalId: string };
  providerId: string;
  publicIdentifier: string | null;
  connector: Pick<MessagingConnector, "getProfile">;
}): Promise<string | null> {
  const who = await resolveParticipant({
    provider: "linkedin",
    userId: args.userId,
    account: args.account,
    providerId: args.providerId,
    publicIdentifier: args.publicIdentifier,
    connector: args.connector,
    allowLookup: false,
  });
  return who.entityId;
}

/**
 * `relation.new`: the person on the other side is connected. Returns the
 * person marked, or null (no such account, not LinkedIn, nobody in the pod).
 */
export async function recordAcceptedRelation(args: {
  accountExternalId: string;
  provider: string;
  providerId: string;
  publicIdentifier: string | null;
  connector: Pick<MessagingConnector, "getProfile">;
  now?: Date;
}): Promise<string | null> {
  if (args.provider.toLowerCase() !== "linkedin") return null;
  const account = await db.query.messagingAccounts.findFirst({
    where: and(
      eq(messagingAccounts.externalId, args.accountExternalId),
      drizzleSql`lower(${messagingAccounts.provider}) = 'linkedin'`
    ),
    columns: { id: true, externalId: true, userId: true },
  });
  if (!account) return null;
  const entityId = await personOf({
    userId: account.userId,
    account,
    providerId: args.providerId,
    publicIdentifier: args.publicIdentifier,
    connector: args.connector,
  });
  if (!entityId) return null;
  const stored = await recordLinkedinReach(
    entityId,
    { connection: "connected", invitedAt: null },
    args.now
  );
  return stored ? entityId : null;
}

export interface LinkedinReachSweepResult {
  /** False when the pod has no messaging service that lists requests. */
  configured: boolean;
  /** LinkedIn accounts whose sent requests were read in full. */
  accountsRead: number;
  /** Accounts whose list could not be read (nothing written for them). */
  accountsFailed: number;
  /** Sent requests read. */
  invitations: number;
  /** People in the pod matched to a sent request (pending, or ignored past 21 days). */
  peopleMarked: number;
  /** People stored pending for more than 21 days, now ignored. */
  peopleIgnored: number;
}

/** The daily sweep. Never throws for a provider failure. */
export async function runLinkedinReachSweep(
  deps: { connector?: MessagingConnector | null; now?: Date } = {}
): Promise<LinkedinReachSweepResult> {
  const now = deps.now ?? new Date();
  const result: LinkedinReachSweepResult = {
    configured: false,
    accountsRead: 0,
    accountsFailed: 0,
    invitations: 0,
    peopleMarked: 0,
    peopleIgnored: 0,
  };
  const connector =
    deps.connector !== undefined
      ? deps.connector
      : await getMessagingConnector("linkedin").catch((err) => {
          logger.warn({ err }, "messaging connector unreadable");
          return null;
        });

  const listSent = connector?.listSentInvitations?.bind(connector);
  if (connector && listSent) {
    result.configured = true;
    const accounts = await db
      .select({
        id: messagingAccounts.id,
        externalId: messagingAccounts.externalId,
        userId: messagingAccounts.userId,
      })
      .from(messagingAccounts)
      .where(
        and(
          drizzleSql`lower(${messagingAccounts.provider}) = 'linkedin'`,
          eq(messagingAccounts.status, "connected")
        )
      );
    for (const account of accounts) {
      // Read the whole list first: a page that fails writes nothing.
      const sent: Array<{
        providerId: string;
        publicIdentifier: string | null;
        sentAt: string | null;
      }> = [];
      try {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_INVITATION_PAGES; page++) {
          const res = await listSent(account.externalId, cursor);
          sent.push(...res.invitations);
          if (!res.nextCursor || res.invitations.length === 0) break;
          cursor = res.nextCursor;
        }
      } catch (err) {
        result.accountsFailed++;
        logger.warn(
          { err, accountId: account.externalId },
          "linkedin reach sweep: sent requests could not be read; nothing written for this account"
        );
        continue;
      }
      result.accountsRead++;
      result.invitations += sent.length;
      for (const inv of sent) {
        const entityId = await personOf({
          userId: account.userId,
          account,
          providerId: inv.providerId,
          publicIdentifier: inv.publicIdentifier,
          connector,
        });
        if (!entityId) continue;
        const stored = await recordLinkedinReach(
          entityId,
          { connection: "pending", invitedAt: inv.sentAt },
          now
        );
        if (stored) result.peopleMarked++;
      }
    }
  }

  // The 21-day rule on what is stored, whatever the reads said: a request
  // pending since more than 21 days is ignored (`settleLinkedinReach`).
  const pending = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.type, "person"),
        isNull(entities.deletedAt),
        drizzleSql`${entities.properties} ->> ${LINKEDIN_CONNECTION_PROPERTY} = 'pending'`
      )
    );
  for (const { id } of pending) {
    const stored = await recordLinkedinReach(
      id,
      { connection: "pending", invitedAt: null },
      now
    );
    if (stored?.connection === "ignored") result.peopleIgnored++;
  }
  return result;
}
