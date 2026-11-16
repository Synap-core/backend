/**
 * What ONE connected LinkedIn account may still do today (wave plan dbc8803a,
 * §2 "Limits"): LinkedIn restricts an account that sends too much, so the pod
 * keeps every account under a daily volume and stops it for the day when
 * LinkedIn pushes back.
 *
 *  - LIMITS: connection requests (`linkedin_invitations_daily`, 20) and all
 *    actions, messages and connection requests together
 *    (`linkedin_actions_daily`, 50), per UTC day. Two axes of the caps fold
 *    (`governance_ceilings`, read by `resolveCeiling`), with the account as
 *    the subject (`messaging_account` + its row id): a row for one account
 *    sets another value for it (`settings.update`, a governed change).
 *  - THE COUNT lives on the account, the way the profile-lookup budget does
 *    (`takeProfileLookup`): `messaging_accounts.metadata.linkedinDaily
 *    {day, actions, invitations}`, spent atomically right before the provider
 *    call, at every door that sends: the channel send door
 *    (`sendExternalMessage`) and a verb's provider call
 *    (`triggerProviderAction`, which every code skill reaches).
 *  - THE PAUSE: a LinkedIn answer that says "slow down" (a 429, a 422
 *    `cannot_resend_yet`, a checkpoint or a restriction) stops the account's
 *    actions until the next UTC midnight, with why
 *    (`metadata.linkedinPause {until, reason, at}`). Nothing retries by
 *    itself; the account read shows it (`GET /messaging/accounts`).
 *
 * A send that would go past either (or while paused) is HELD, never refused
 * or lost: its proposal stays pending with `data.held` (`held-sends.ts`,
 * errorClass `linkedin_limit`) until `until`, and is sendable again from then.
 *
 * Only accounts whose provider is `linkedin` are counted; every other
 * account (WhatsApp, email…) goes on exactly as before.
 */

import { db, and, eq, drizzleSql } from "@synap/database";
import { messagingAccounts } from "@synap/database/schema";
import { resolveCeiling } from "@synap/database/agent-governance";
import { humanizeToken } from "@synap-core/types/vocabulary";
import type { HeldSend } from "./held-sends.js";

/** What a LinkedIn action is, for the counts. */
export type LinkedinActionKind = "invitation" | "message";

/** Why LinkedIn paused an account (a stable code; the CRM words it). */
export const LINKEDIN_PAUSE_REASONS = [
  "rate_limited",
  "cannot_resend_yet",
  "restricted",
] as const;
export type LinkedinPauseReason = (typeof LINKEDIN_PAUSE_REASONS)[number];

/** `messaging_accounts.metadata.linkedinPause`. */
export interface LinkedinPause {
  /** When the account may act again (ISO, the next UTC midnight). */
  until: string;
  reason: LinkedinPauseReason;
  /** When LinkedIn said it (ISO). */
  at: string;
}

/** The ceiling subject that names one messaging account. */
export const MESSAGING_ACCOUNT_SUBJECT = "messaging_account";

/** The UTC day of `now`, as the counts key it. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next UTC midnight after `now`: when today's counts and pause end. */
export function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
}

/** The pause an account's metadata holds, while it still holds. */
export function readLinkedinPause(
  metadata: unknown,
  now: Date = new Date()
): LinkedinPause | null {
  if (!metadata || typeof metadata !== "object") return null;
  const p = (metadata as Record<string, unknown>).linkedinPause;
  if (!p || typeof p !== "object") return null;
  const { until, reason, at } = p as Record<string, unknown>;
  if (typeof until !== "string" || typeof reason !== "string") return null;
  const end = Date.parse(until);
  if (Number.isNaN(end) || end <= now.getTime()) return null;
  return {
    until,
    reason: reason as LinkedinPauseReason,
    at: typeof at === "string" ? at : until,
  };
}

/**
 * The connected LinkedIn account of `userId` the provider knows as
 * `externalId` (Unipile's account id), or null when that id names no
 * LinkedIn account of theirs (another provider's account is never counted).
 */
export async function linkedinAccountOf(
  userId: string,
  externalId: string
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: messagingAccounts.id })
    .from(messagingAccounts)
    .where(
      and(
        eq(messagingAccounts.userId, userId),
        eq(messagingAccounts.externalId, externalId),
        drizzleSql`lower(${messagingAccounts.provider}) = 'linkedin'`
      )
    )
    .limit(1);
  return row ?? null;
}

/** The two daily limits in force for one account (a row for it, else the defaults). */
export async function linkedinDailyLimits(
  accountRowId: string
): Promise<{ invitations: number; actions: number }> {
  const subject = { type: MESSAGING_ACCOUNT_SUBJECT, id: accountRowId };
  const [invitations, actions] = await Promise.all([
    resolveCeiling({ db, axis: "linkedin_invitations_daily", subject }),
    resolveCeiling({ db, axis: "linkedin_actions_daily", subject }),
  ]);
  return { invitations: invitations.value, actions: actions.value };
}

function countsOf(
  metadata: unknown,
  now: Date
): { actions: number; invitations: number } {
  const d =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).linkedinDaily
      : null;
  if (!d || typeof d !== "object") return { actions: 0, invitations: 0 };
  const rec = d as Record<string, unknown>;
  if (rec.day !== utcDay(now)) return { actions: 0, invitations: 0 };
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  return { actions: n(rec.actions), invitations: n(rec.invitations) };
}

const UNTIL_WORDS = "It can go from tomorrow (00:00 UTC).";

/**
 * Why this account may not make one more `kind` action today, as the hold a
 * send waits under, or null when it may. Pure: the account's metadata and
 * its limits.
 */
export function linkedinBlockOf(args: {
  metadata: unknown;
  kind: LinkedinActionKind;
  limits: { invitations: number; actions: number };
  now: Date;
}): HeldSend | null {
  const { metadata, kind, limits, now } = args;
  const at = now.toISOString();
  const pause = readLinkedinPause(metadata, now);
  if (pause) {
    return {
      errorClass: "linkedin_limit",
      reason: `LinkedIn paused this account for today (${humanizeToken(pause.reason).toLowerCase()}). It can go once the pause ends.`,
      at,
      until: pause.until,
    };
  }
  const used = countsOf(metadata, now);
  const until = nextUtcDay(now).toISOString();
  if (kind === "invitation" && used.invitations >= limits.invitations) {
    return {
      errorClass: "linkedin_limit",
      reason: `This LinkedIn account sent today's ${limits.invitations} connection requests. ${UNTIL_WORDS}`,
      at,
      until,
    };
  }
  if (used.actions >= limits.actions) {
    return {
      errorClass: "linkedin_limit",
      reason: `This LinkedIn account made today's ${limits.actions} LinkedIn actions (messages and connection requests). ${UNTIL_WORDS}`,
      at,
      until,
    };
  }
  return null;
}

/** Read the account's metadata (a failed read throws). */
async function accountMetadata(accountRowId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadata: messagingAccounts.metadata })
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, accountRowId))
    .limit(1);
  if (!row) throw new Error(`Messaging account ${accountRowId} not found.`);
  return row.metadata;
}

/**
 * Would one more `kind` action be held right now? A read, nothing spent: for
 * the doors that decide BEFORE filing or running (a send filed while the
 * account is paused is filed held).
 */
export async function linkedinActionBlock(
  accountRowId: string,
  kind: LinkedinActionKind,
  now: Date = new Date()
): Promise<HeldSend | null> {
  const [metadata, limits] = await Promise.all([
    accountMetadata(accountRowId),
    linkedinDailyLimits(accountRowId),
  ]);
  return linkedinBlockOf({ metadata, kind, limits, now });
}

/**
 * Spend one `kind` action from the account's day, right before the provider
 * call. Atomic: the UPDATE lands only while the account is not paused and
 * today's counts are under both limits (a connection request counts in both).
 * `null` = spent, go; a hold = do not send, hold it.
 */
export async function takeLinkedinAction(
  accountRowId: string,
  kind: LinkedinActionKind,
  now: Date = new Date()
): Promise<HeldSend | null> {
  const limits = await linkedinDailyLimits(accountRowId);
  const day = utcDay(now);
  const inv = kind === "invitation" ? 1 : 0;
  const meta = drizzleSql`COALESCE(${messagingAccounts.metadata}, '{}'::jsonb)`;
  const today = drizzleSql`COALESCE(${meta} -> 'linkedinDaily' ->> 'day', '') = ${day}`;
  const actions = drizzleSql`COALESCE((${meta} -> 'linkedinDaily' ->> 'actions')::int, 0)`;
  const invitations = drizzleSql`COALESCE((${meta} -> 'linkedinDaily' ->> 'invitations')::int, 0)`;
  const rows = await db
    .update(messagingAccounts)
    .set({
      metadata: drizzleSql`jsonb_set(${meta}, '{linkedinDaily}', jsonb_build_object(
        'day', ${day}::text,
        'actions', CASE WHEN ${today} THEN ${actions} + 1 ELSE 1 END,
        'invitations', CASE WHEN ${today} THEN ${invitations} + ${inv}::int ELSE ${inv}::int END))`,
    })
    .where(
      and(
        eq(messagingAccounts.id, accountRowId),
        drizzleSql`(${meta} -> 'linkedinPause' ->> 'until' IS NULL
          OR (${meta} -> 'linkedinPause' ->> 'until')::timestamptz <= ${now.toISOString()}::timestamptz)`,
        drizzleSql`(NOT ${today} OR ${actions} < ${limits.actions}::int)`,
        drizzleSql`(${inv}::int = 0 OR NOT ${today} OR ${invitations} < ${limits.invitations}::int)`
      )
    )
    .returning({ id: messagingAccounts.id });
  if (rows.length > 0) return null;
  // Not spent: say why, from the row as it is now.
  const metadata = await accountMetadata(accountRowId);
  return (
    linkedinBlockOf({ metadata, kind, limits, now }) ?? {
      // The row moved between the UPDATE and this read (a new day began):
      // still not sent this time, and it can go at once.
      errorClass: "linkedin_limit",
      reason: "This LinkedIn account's daily count was busy. Send it again.",
      at: now.toISOString(),
      until: now.toISOString(),
    }
  );
}

/**
 * Did LinkedIn tell this account to slow down? Only a provider REFUSAL (a
 * 4xx answer) counts: a 429, a 422 `cannot_resend_yet`, or a checkpoint /
 * restriction answer (Unipile's error `type`, in the error text). Read for a
 * LinkedIn account only: every other provider keeps the shared classifier
 * (`classifyDispatchFailure`) as it is.
 */
export function linkedinThrottleOf(
  status: number,
  message: string | undefined
): LinkedinPauseReason | null {
  if (!(status >= 400 && status < 500)) return null;
  const text = message ?? "";
  if (/cannot_resend_yet/i.test(text)) return "cannot_resend_yet";
  if (/checkpoint|restricted/i.test(text)) return "restricted";
  if (status === 429 || /too_many_requests/i.test(text)) return "rate_limited";
  return null;
}

/** Pause the account's LinkedIn actions until the next UTC midnight. */
export async function pauseLinkedinAccount(
  accountRowId: string,
  reason: LinkedinPauseReason,
  now: Date = new Date()
): Promise<LinkedinPause> {
  const pause: LinkedinPause = {
    until: nextUtcDay(now).toISOString(),
    reason,
    at: now.toISOString(),
  };
  await db
    .update(messagingAccounts)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${messagingAccounts.metadata}, '{}'::jsonb), '{linkedinPause}', ${JSON.stringify(pause)}::jsonb)`,
    })
    .where(eq(messagingAccounts.id, accountRowId));
  return pause;
}

/**
 * A provider call that is a LinkedIn action, read from its Unipile path:
 * a connection request (`POST /{account}/users/me/relation-requests`) or a
 * message (`POST /{account}/chats/{chat}/messages/send`,
 * `/{account}/chats/send`, `/{account}/inboxes/{inbox}/chats/send`), with the
 * provider's account id it acts as. Anything else (a read, another provider's
 * path) is null.
 */
export function linkedinProviderAction(
  method: string,
  path: string
): { kind: LinkedinActionKind; accountExternalId: string } | null {
  if (method.toUpperCase() !== "POST") return null;
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  const invite = /^\/([^/]+)\/users\/me\/relation-requests$/.exec(p);
  if (invite) {
    return {
      kind: "invitation",
      accountExternalId: decodeURIComponent(invite[1]!),
    };
  }
  const message =
    /^\/([^/]+)\/(?:chats\/[^/]+\/messages\/send|chats\/send|inboxes\/[^/]+\/chats\/send)$/.exec(
      p
    );
  if (message) {
    return {
      kind: "message",
      accountExternalId: decodeURIComponent(message[1]!),
    };
  }
  return null;
}

/**
 * The one guard both send doors run around their provider call, for a
 * LinkedIn account: spend the action first (a hold = do not call), then read
 * the answer for a "slow down" and pause the account on one.
 */
export async function guardLinkedinAction<T>(args: {
  accountRowId: string;
  kind: LinkedinActionKind;
  call: () => Promise<T>;
  /** The provider's refusal in the result, when it refused (status, text). */
  refusalOf: (result: T) => { status: number; message?: string } | null;
  now?: Date;
}): Promise<{ held: HeldSend } | { result: T }> {
  const now = args.now ?? new Date();
  const held = await takeLinkedinAction(args.accountRowId, args.kind, now);
  if (held) return { held };
  const result = await args.call();
  const refusal = args.refusalOf(result);
  if (refusal) await pauseIfThrottled(args.accountRowId, refusal, now);
  return { result };
}

/** Pause the account when a LinkedIn refusal says to slow down. */
export async function pauseIfThrottled(
  accountRowId: string,
  refusal: { status: number; message?: string },
  now: Date = new Date()
): Promise<LinkedinPause | null> {
  const reason = linkedinThrottleOf(refusal.status, refusal.message);
  return reason ? pauseLinkedinAccount(accountRowId, reason, now) : null;
}

/**
 * A verb run that did not go out, approved as a proposal: is it a LinkedIn
 * action its account may not make today? Then the proposal is HELD rather
 * than failed. A verb joins by declaring its intent (`request_connection`
 * is a connection request, `send_message` a message) and naming the account
 * it acts as in its `accountId` parameter, as the LinkedIn verbs do; any
 * other run is not this door's.
 */
export async function linkedinRunHold(args: {
  userId: string;
  intent: string | null | undefined;
  params: Record<string, unknown>;
  now?: Date;
}): Promise<HeldSend | null> {
  const kind: LinkedinActionKind | null =
    args.intent === "request_connection"
      ? "invitation"
      : args.intent === "send_message"
        ? "message"
        : null;
  if (!kind) return null;
  const accountId =
    typeof args.params.accountId === "string"
      ? args.params.accountId.trim()
      : "";
  if (!accountId) return null;
  const account = await linkedinAccountOf(args.userId, accountId);
  return account ? linkedinActionBlock(account.id, kind, args.now) : null;
}
