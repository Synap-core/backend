/**
 * A message to a person that cannot go out YET (CRM Messages contract
 * b4f8c2cd, B: "a draft is never refused and never lost").
 *
 * A LinkedIn first message to someone who is not a 1st-degree connection
 * (or whose request still waits) is HELD: the `messaging.external.send`
 * proposal is filed (or stays) PENDING with `data.held = {errorClass,
 * reason, at}`. It is shown, it keeps its text, and it becomes sendable the
 * moment the person connects:
 *   - at filing (`sendExternalMessage`), instead of the S4a refusal;
 *   - at approval (`messaging.external.send` executor), instead of
 *     APPROVAL_FAILED: the approval re-reads the reach live every time;
 *   - released (`held` removed) when the pod records them `connected`
 *     (`recordLinkedinReach`: `relation.new`, the daily sweep, a send's own
 *     profile read).
 *
 * And a send the person made OUTSIDE the pod (straight from LinkedIn) closes
 * the drafts it replaces (`withdrawDraftsSentOutside`, contract E).
 *
 * Only `not_connected` holds. Every other refusal is what it was: a failed
 * READ (LinkedIn down) files as before and is checked again at dispatch; an
 * unknown reach is never "not connected".
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  isNotNull,
  lte,
  or,
  drizzleSql,
  transitionProposal,
} from "@synap/database";
import { proposals, ProposalStatus } from "@synap/database/schema";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";

const logger = createLogger({ module: "held-sends" });

/** The proposal type a message to a person is. */
const SEND_TYPE = "messaging.external.send";

/** Why a pending send cannot go out yet, on `proposals.data.held`. */
export interface HeldSend {
  errorClass: "not_connected";
  /** The sentence that names the next step ("Ask to connect first."). */
  reason: string;
  /** When the pod last found it unreachable (ISO). */
  at: string;
}

/** The `held` record for a `not_connected` refusal. */
export function heldSend(reason: string, now: Date = new Date()): HeldSend {
  return { errorClass: "not_connected", reason, at: now.toISOString() };
}

/** The `held` record a proposal's data carries, or null. */
export function readHeld(data: unknown): HeldSend | null {
  if (!data || typeof data !== "object") return null;
  const held = (data as Record<string, unknown>).held;
  if (!held || typeof held !== "object") return null;
  const h = held as Record<string, unknown>;
  return typeof h.reason === "string" && typeof h.at === "string"
    ? { errorClass: "not_connected", reason: h.reason, at: h.at }
    : null;
}

/**
 * Keep an approved-but-unreachable send PENDING with `held` (never
 * APPROVAL_FAILED). A pending row gets `held` written on its data; a row a
 * previous approval had marked failed is reopened as pending (its failure
 * dropped: the reason is now `held`). Anything else (approved meanwhile,
 * withdrawn, rejected) is left alone.
 */
export async function holdPendingSend(
  proposalId: string,
  held: HeldSend
): Promise<void> {
  const patch = JSON.stringify({ held });
  await db
    .update(proposals)
    .set({
      data: drizzleSql`(COALESCE(${proposals.data}, '{}'::jsonb) - 'failure') || ${patch}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.proposalType, SEND_TYPE),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  await transitionProposal(db, {
    to: ProposalStatus.PENDING,
    from: [ProposalStatus.APPROVAL_FAILED],
    set: {
      data: drizzleSql`(COALESCE(${proposals.data}, '{}'::jsonb) - 'failure') || ${patch}::jsonb`,
      rejectionReason: null,
      updatedAt: new Date(),
    },
    where: and(
      eq(proposals.id, proposalId),
      eq(proposals.proposalType, SEND_TYPE)
    ),
  });
}

/**
 * The person is now reachable: every pending send to them that was held is
 * sendable again (`held` removed). Returns how many were released.
 */
export async function releaseHeldSends(entityId: string): Promise<number> {
  const rows = await db
    .update(proposals)
    .set({
      data: drizzleSql`${proposals.data} - 'held'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.proposalType, SEND_TYPE),
        eq(proposals.status, ProposalStatus.PENDING),
        drizzleSql`${proposals.data} ->> 'entityId' = ${entityId}`,
        drizzleSql`${proposals.data} ? 'held'`
      )
    )
    .returning({ id: proposals.id });
  if (rows.length > 0) {
    logger.info(
      { entityId, released: rows.length },
      "held sends released: the person is now connected"
    );
  }
  return rows.length;
}

/**
 * The person sent a message in this conversation from the provider itself
 * (LinkedIn's own app): the drafts it replaces are done, not left waiting.
 * Withdraws the channel's PENDING sends filed at or before that message.
 *
 * THE ECHO GUARD: the provider also echoes a send the POD made, and that
 * echo must never withdraw anything (neither the send in flight nor the
 * channel's other drafts). A pod send holds its at-most-once claim
 * (`external_dispatched_at`, set BEFORE the provider call,
 * `dispatchExternalOnce`) while it is in flight, and once delivered its
 * approved row names the provider's message id (`sentResult`). So when the
 * channel has a send in flight, or a sent one with this message id, the
 * message is (or may be) the echo: nothing is withdrawn. A row with the
 * claim set is never withdrawn either. The caller passes only a NEW outbound
 * row (an echo of a send already recorded is a duplicate and records
 * nothing).
 */
export async function withdrawDraftsSentOutside(args: {
  channelId: string;
  /** When the outside message was sent: a draft filed after it stays. */
  sentAt: Date;
  /** The recorded outbound message, for the withdrawal's trace. */
  messageId: string;
  /** The provider's id of that message, when it gave one. */
  externalMessageId: string | null;
  provider: string;
}): Promise<string[]> {
  const onChannel = drizzleSql`${proposals.data} ->> 'channelId' = ${args.channelId}`;
  const [podSend] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, SEND_TYPE),
        onChannel,
        or(
          and(
            eq(proposals.status, ProposalStatus.PENDING),
            isNotNull(proposals.externalDispatchedAt)
          ),
          args.externalMessageId
            ? drizzleSql`${proposals.data} -> 'sentResult' ->> 'externalMessageId' = ${args.externalMessageId}`
            : drizzleSql`false`
        )
      )
    )
    .limit(1);
  if (podSend) {
    logger.debug(
      { channelId: args.channelId, proposalId: podSend.id },
      "outbound message is (or may be) the echo of a pod send: no draft withdrawn"
    );
    return [];
  }
  const reason = `Sent from ${args.provider} directly; this draft was not needed.`;
  const rows = await transitionProposal(db, {
    to: ProposalStatus.WITHDRAWN,
    from: [ProposalStatus.PENDING],
    set: {
      updatedAt: new Date(),
      data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object('withdrawReason', ${reason}::text, 'closedByMessageId', ${args.messageId}::text)`,
    },
    where: and(
      eq(proposals.proposalType, SEND_TYPE),
      onChannel,
      isNull(proposals.externalDispatchedAt),
      lte(proposals.createdAt, args.sentAt)
    ),
  }).returning({ id: proposals.id });
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    markProposalNotificationsActioned(ids);
    logger.info(
      { channelId: args.channelId, withdrawn: ids.length },
      "drafts withdrawn: the person sent a message from the provider itself"
    );
  }
  return ids;
}
