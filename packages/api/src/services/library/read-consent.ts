/**
 * The CONSENT a "Read with X" tap gives for an item that could not be read at
 * once (over today's budget, or a billed reader's retry) — and its END.
 *
 * The tap is the person's consent to run that reader (on their account) for
 * that item. The pod remembers it on the item (`importRead.requestedReader`,
 * `requestedAt`, and `heldFrom` — the waiting status the item had before the
 * tap) so the hourly sweep can read it once the budget has room. An item
 * that already HAS a read (a re-read, "Get the pictures") keeps it: status
 * `read`, the consent beside it. A consent is
 * not open-ended:
 *   - it EXPIRES after {@link libraryReadConsentDays} days
 *     (env `SYNAP_LIBRARY_READ_CONSENT_DAYS`, default 7): the sweep forgets it
 *     first ({@link expireLibraryReadConsents}), and a job that still finds an
 *     expired one never runs it ({@link isLibraryReadConsentLive});
 *   - the person may CANCEL it (`library.cancelReadWith`,
 *     {@link cancelLibraryReadConsents}).
 * Either way the item goes back to the status it had before the tap
 * (`heldFrom`; a `read` item simply stays read), else "needs a reader"
 * (`needs_file`) — and nothing is read or billed. A consent with no readable `requestedAt` (stored
 * before consents were dated) counts as expired: a bill needs a dated consent.
 */

import { documents, drizzleSql, and, inArray, type SQL } from "@synap/database";
import { envInt } from "@synap/shared-utils";
import {
  LIBRARY_READ_CONSENT_DAYS_DEFAULT,
  type LibraryReadConsent,
  type LibraryReadStatus,
} from "@synap-core/types/imports";
import { inGroupSql, libraryItemsWhere, type LibraryDb } from "./read-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The statuses a held item goes back to when its consent ends (`heldFrom` may
 * only be one of them): those it waits in for a reader. (A `read` item is
 * never held as `over_budget`: it waits WITH its read, status unchanged.)
 */
export const LIBRARY_CONSENT_RESTORE_STATUSES: readonly LibraryReadStatus[] = [
  "needs_file",
  "title_only",
  "unreadable",
];

/** The statuses an item holding a consent waits in (see {@link libraryReadConsentOf}). */
const CONSENT_WAITS_IN: readonly LibraryReadStatus[] = [
  "over_budget",
  "not_read",
  "read",
];

/** Days a "Read with X" consent lasts (env `SYNAP_LIBRARY_READ_CONSENT_DAYS`, 1–365). */
export function libraryReadConsentDays(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(env, "SYNAP_LIBRARY_READ_CONSENT_DAYS", {
    default: LIBRARY_READ_CONSENT_DAYS_DEFAULT,
    min: 1,
    max: 365,
  });
}

/** The consent fields as stored on `importRead`. */
export interface StoredReadConsent {
  requestedReader?: string;
  requestedAt?: string;
  heldFrom?: LibraryReadStatus;
  /** The "with video" choice given with the consent (ends with it). */
  requestedWithVideo?: true;
  /** "Get the pictures" (`missingMedia`): a read the item has is kept (ends with it). */
  requestedKeepRead?: true;
}

function parsedAt(at: string | undefined): number | null {
  if (typeof at !== "string") return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * PURE: the live consent on a stored read, or undefined (none, undated, or
 * ended at `now`). Only an item still waiting for that read carries one:
 * `over_budget`, `not_read`, or `read` (a re-read waiting beside its read).
 */
export function libraryReadConsentOf(
  stored: StoredReadConsent & { status: LibraryReadStatus },
  now: Date,
  days: number = libraryReadConsentDays()
): LibraryReadConsent | undefined {
  if (!stored.requestedReader) return undefined;
  if (!CONSENT_WAITS_IN.includes(stored.status)) return undefined;
  const at = parsedAt(stored.requestedAt);
  if (at === null) return undefined;
  const ends = at + days * DAY_MS;
  if (ends <= now.getTime()) return undefined;
  return {
    readerId: stored.requestedReader,
    givenAt: new Date(at).toISOString(),
    expiresAt: new Date(ends).toISOString(),
    ...(stored.requestedWithVideo ? { withVideo: true as const } : {}),
  };
}

/** PURE: may a job still run the remembered reader? (dated and not ended) */
export function isLibraryReadConsentLive(
  stored: StoredReadConsent,
  now: Date,
  days: number = libraryReadConsentDays()
): boolean {
  const at = parsedAt(stored.requestedAt);
  return (
    !!stored.requestedReader &&
    at !== null &&
    at + days * DAY_MS > now.getTime()
  );
}

/** When a consent given at `at` ends (ISO). */
export function libraryReadConsentEndsAt(
  at: Date,
  days: number = libraryReadConsentDays()
): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString();
}

/** PURE: the waiting status to keep as `heldFrom` when an item is held for a consent. */
export function heldFromStatus(prev: {
  status: LibraryReadStatus;
  heldFrom?: LibraryReadStatus;
}): LibraryReadStatus | undefined {
  if (
    prev.heldFrom &&
    LIBRARY_CONSENT_RESTORE_STATUSES.includes(prev.heldFrom)
  ) {
    return prev.heldFrom;
  }
  return LIBRARY_CONSENT_RESTORE_STATUSES.includes(prev.status)
    ? prev.status
    : undefined;
}

/** SQL: `heldFrom` is one of {@link LIBRARY_CONSENT_RESTORE_STATUSES}. */
export function restorableStatusSql(status: SQL): SQL {
  return drizzleSql`${status} IN (${drizzleSql.join(
    LIBRARY_CONSENT_RESTORE_STATUSES.map((s) => drizzleSql`${s}`),
    drizzleSql`, `
  )})`;
}

/**
 * SQL: `importRead` with its consent forgotten. An `over_budget` item goes
 * back to `heldFrom` (the status it had before the hold), else `needs_file`;
 * any other status is kept (a `not_read` retry is then read by the pod's own
 * ladder only).
 */
const FORGOTTEN_READ = drizzleSql`(
  (${documents.metadata} -> 'importRead') - 'requestedReader' - 'requestedAt' - 'heldFrom' - 'requestedWithVideo' - 'requestedKeepRead'
  || CASE WHEN ${documents.metadata} #>> '{importRead,status}' = 'over_budget'
       THEN jsonb_build_object('status',
         CASE WHEN ${restorableStatusSql(drizzleSql`${documents.metadata} #>> '{importRead,heldFrom}'`)}
           THEN ${documents.metadata} #>> '{importRead,heldFrom}'
           ELSE 'needs_file' END)
       ELSE '{}'::jsonb END)`;

const HOLDS_CONSENT = drizzleSql`${documents.metadata} -> 'importRead' ? 'requestedReader'`;

/** The consent's start as a timestamp, `-infinity` when absent or unreadable. */
const CONSENT_AT = drizzleSql`(CASE WHEN ${documents.metadata} #>> '{importRead,requestedAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  THEN (${documents.metadata} #>> '{importRead,requestedAt}')::timestamptz
  ELSE '-infinity'::timestamptz END)`;

/** SQL: this row's consent has ended (or was never dated). */
export function consentEndedSql(days: number): SQL {
  return drizzleSql`(${HOLDS_CONSENT} AND ${CONSENT_AT} <= now() - make_interval(days => ${days}))`;
}

/**
 * SQL twin of {@link libraryReadConsentOf}: the row holds a LIVE consent — a
 * remembered reader, the item still waiting for that read, dated and not
 * ended. What `read.consent` shows, counted.
 */
export function consentLiveSql(days: number = libraryReadConsentDays()): SQL {
  return drizzleSql`(${HOLDS_CONSENT} AND ${documents.metadata} #>> '{importRead,status}' IN (${drizzleSql.join(
    CONSENT_WAITS_IN.map((s) => drizzleSql`${s}`),
    drizzleSql`, `
  )}) AND ${CONSENT_AT} > now() - make_interval(days => ${days}))`;
}

async function forget(
  database: Pick<LibraryDb, "update">,
  where: SQL
): Promise<Array<{ id: string; userId: string; metadata: unknown }>> {
  return database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importRead}', ${FORGOTTEN_READ})`,
      updatedAt: new Date(),
    })
    .where(where)
    .returning({
      id: documents.id,
      userId: documents.userId,
      metadata: documents.metadata,
    });
}

/**
 * Forget every ENDED consent (all people). Run by the sweep before it picks
 * what to read, so an ended consent is never queued.
 */
export async function expireLibraryReadConsents(
  database: Pick<LibraryDb, "update">,
  days: number = libraryReadConsentDays()
): Promise<Array<{ id: string; userId: string; metadata: unknown }>> {
  return forget(
    database,
    and(
      drizzleSql`${documents.deletedAt} IS NULL`,
      drizzleSql`${documents.metadata} ? 'importItem'`,
      consentEndedSql(days)
    )!
  );
}

/** Forget ONE item's consent (a job that found it ended). */
export async function forgetLibraryReadConsent(
  database: Pick<LibraryDb, "update">,
  userId: string,
  itemId: string
): Promise<boolean> {
  const rows = await forget(
    database,
    and(
      libraryItemsWhere(userId),
      inArray(documents.id, [itemId]),
      HOLDS_CONSENT
    )!
  );
  return rows.length > 0;
}

/**
 * The person's cancel: forget the consents of one scope — items, a group's
 * items, or every item holding one. Owner-floored. Returns the rows changed.
 */
export async function cancelLibraryReadConsents(
  database: Pick<LibraryDb, "update">,
  args: {
    userId: string;
    itemIds?: readonly string[];
    groupId?: string;
  }
): Promise<Array<{ id: string; userId: string; metadata: unknown }>> {
  const scope: SQL[] = [];
  if (args.itemIds?.length) {
    scope.push(inArray(documents.id, [...new Set(args.itemIds)]));
  }
  if (args.groupId) scope.push(inGroupSql(args.groupId));
  return forget(
    database,
    and(libraryItemsWhere(args.userId), HOLDS_CONSENT, ...scope)!
  );
}
