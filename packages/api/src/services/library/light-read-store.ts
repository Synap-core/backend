/**
 * The light read's stored state: `documents.metadata.importRead` as the pod
 * keeps it (the contract plus bookkeeping), its three writers — the
 * billed-read checkpoint, the read itself (under a row lock, keeping chips run
 * meanwhile) and an explicit re-read's last attempt — and the item's job
 * LEASE (`metadata.importReadLease`), which keeps two jobs from reading one
 * item at once. Every writer leaves a deleted item alone.
 */

import { randomUUID } from "node:crypto";
import { documents, drizzleSql, and, eq, isNull } from "@synap/database";
import {
  carryRunLibraryActions,
  LIBRARY_READ_STATUSES,
  readLibraryItemRead,
  type LibraryItemRead,
  type LibraryReadBlocked,
  type LibraryReadStatus,
} from "@synap-core/types/imports";
import {
  normalizeUrlRead,
  readReaderStamp,
  type UrlRead,
} from "@synap-core/types/url-read";
import type { LibraryReadDb } from "./read-budget.js";
import {
  LIGHT_READ_TEXT_MAX,
  READ_CHECKPOINT_TTL_MS,
} from "./light-read-limits.js";

/** `importRead` as stored: the contract plus pod-internal bookkeeping. */
export interface StoredLibraryRead extends LibraryItemRead {
  /** Storage key of the read text (`libraryReadTextKey`). */
  textKey?: string;
  /** When the AI budget was spent for this item (read-budget.ts). */
  aiAt?: string;
  /**
   * Failures that count toward `unreadable` so far: permanent classes, and
   * every failure of a billed reader (see `LIGHT_READ_MAX_ATTEMPTS`).
   */
  attempts?: number;
  /** Consecutive transient failures (the backoff exponent); never counts toward `unreadable`. */
  transientFailures?: number;
  /** The last failed read's error (kept when it ends `unreadable`). */
  lastError?: string;
  /**
   * The reader the person chose for a read that has not happened yet (over
   * budget, or failed and waiting for its retry): the sweep's job reads with
   * it, so a retry never silently falls back to the free reader.
   */
  requestedReader?: string;
  /**
   * When the person gave that choice (ISO): the consent ENDS
   * `SYNAP_LIBRARY_READ_CONSENT_DAYS` later (`read-consent.ts`). A retry keeps
   * the tap's date — a consent is never renewed by the pod itself.
   */
  requestedAt?: string;
  /** The waiting status the item had before it was held for the consent (restored when it ends). */
  heldFrom?: LibraryReadStatus;
  /** The person's "with video" choice on that tap; it ends with the consent. */
  requestedWithVideo?: true;
  /**
   * A BILLED read that succeeded, held until the item's read is written
   * (media copy, transcript, summary still to come). The same reader run
   * again for this item within {@link READ_CHECKPOINT_TTL_MS} resumes from
   * it instead of billing the person's account again. Cleared by the final
   * write; kept across a retry (`not_read`).
   */
  readCheckpoint?: ReadCheckpoint;
  /** An explicit RE-read that did not read (the earlier read is kept). */
  lastAttempt?: {
    readerId: string;
    status: LibraryReadStatus;
    blocked?: LibraryReadBlocked;
    error?: string;
    at: string;
  };
}

/**
 * THE pod-side reader of the stored `importRead`: the contract fields through
 * `readLibraryItemRead` (validated, with its content-status fallback), plus
 * the pod's bookkeeping as stored, each kept only with its own type. `exists`
 * is false when the light read never wrote anything on the item. Every read
 * of the stored shape in the pod goes through here; the writers below stay
 * the only writers.
 */
export function readStoredLibraryRead(
  metadata: unknown,
  contentStatus?: string
): { exists: boolean; read: StoredLibraryRead } {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).importRead
      : undefined;
  const bag =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const read: StoredLibraryRead = readLibraryItemRead(metadata, contentStatus);
  if (!bag) return { exists: false, read };
  const str = (k: string) =>
    typeof bag[k] === "string" && bag[k] ? (bag[k] as string) : undefined;
  const num = (k: string) =>
    typeof bag[k] === "number" && Number.isFinite(bag[k])
      ? (bag[k] as number)
      : undefined;
  const obj = (k: string) =>
    bag[k] && typeof bag[k] === "object" ? bag[k] : undefined;
  const textKey = str("textKey");
  const aiAt = str("aiAt");
  const lastError = str("lastError");
  const requestedReader = str("requestedReader");
  const requestedAt = str("requestedAt");
  const heldFromRaw = str("heldFrom");
  const heldFrom = (LIBRARY_READ_STATUSES as readonly string[]).includes(
    heldFromRaw ?? ""
  )
    ? (heldFromRaw as LibraryReadStatus)
    : undefined;
  const attempts = num("attempts");
  const transientFailures = num("transientFailures");
  const readCheckpoint = obj("readCheckpoint");
  const lastAttempt = obj("lastAttempt");
  return {
    exists: true,
    read: {
      ...read,
      ...(textKey ? { textKey } : {}),
      ...(aiAt ? { aiAt } : {}),
      ...(lastError ? { lastError } : {}),
      ...(requestedReader ? { requestedReader } : {}),
      ...(requestedAt ? { requestedAt } : {}),
      ...(heldFrom ? { heldFrom } : {}),
      ...(bag.requestedWithVideo === true
        ? { requestedWithVideo: true as const }
        : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      ...(transientFailures !== undefined ? { transientFailures } : {}),
      // Re-parsed where it is used (`resumableRead`), never trusted here.
      ...(readCheckpoint
        ? { readCheckpoint: readCheckpoint as ReadCheckpoint }
        : {}),
      ...(lastAttempt
        ? { lastAttempt: lastAttempt as StoredLibraryRead["lastAttempt"] }
        : {}),
    },
  };
}

export interface ReadCheckpoint {
  /** The reader id that produced `read` (a verb id). */
  readerId: string;
  at: string;
  read: UrlRead;
}

/**
 * The checkpointed read for `reader`, or null when there is none to resume
 * (another reader, too old, or not a usable read). Re-parsed through the one
 * parse door, never trusted as stored.
 */
export function resumableRead(
  checkpoint: unknown,
  reader: string,
  sourceUrl: string,
  now: Date
): UrlRead | null {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const cp = checkpoint as Partial<Record<keyof ReadCheckpoint, unknown>>;
  if (cp.readerId !== reader || typeof cp.at !== "string") return null;
  const age = now.getTime() - Date.parse(cp.at);
  if (!Number.isFinite(age) || age < 0 || age > READ_CHECKPOINT_TTL_MS) {
    return null;
  }
  const via = readReaderStamp((cp.read as { via?: unknown } | null)?.via);
  if (!via) return null;
  const read = normalizeUrlRead(cp.read, sourceUrl, via);
  return read.status === "ok" || read.status === "partial" ? read : null;
}

/** Hold a billed read on the item before the slow part of the job runs. */
export async function saveReadCheckpoint(
  database: LibraryReadDb,
  itemId: string,
  checkpoint: ReadCheckpoint
): Promise<void> {
  // Bounded like the stored text: the checkpoint is transient, not a copy.
  const read: UrlRead = {
    ...checkpoint.read,
    ...(checkpoint.read.text
      ? { text: checkpoint.read.text.slice(0, LIGHT_READ_TEXT_MAX) }
      : {}),
    ...(checkpoint.read.transcript
      ? {
          transcript: {
            ...checkpoint.read.transcript,
            text: checkpoint.read.transcript.text.slice(0, LIGHT_READ_TEXT_MAX),
          },
        }
      : {}),
  };
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importRead}', coalesce(${documents.metadata} -> 'importRead', '{"status":"not_read","suggestedActions":[]}'::jsonb) || jsonb_build_object('readCheckpoint', ${JSON.stringify({ ...checkpoint, read })}::jsonb))`,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, itemId), isNull(documents.deletedAt)));
}

/**
 * Write the new read into the bag, keeping chips run meanwhile. `false` =
 * nothing written: the item was deleted (checked under the same row lock, so
 * a read finishing after the delete never re-writes nor re-indexes it), or an
 * automatic read yielded to one that landed meanwhile.
 */
export async function writeRead(
  database: LibraryReadDb,
  itemId: string,
  next: Omit<StoredLibraryRead, "aiAt">,
  /**
   * An AUTOMATIC read that did not read yields to a read that landed while it
   * ran (an explicit "Read with X" job on the same item): the queue's
   * singletonKey does not dedupe on a standard pg-boss v10 queue, so two jobs
   * of one item can overlap.
   */
  yieldToRead = false
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: documents.metadata })
      .from(documents)
      .where(and(eq(documents.id, itemId), isNull(documents.deletedAt)))
      .for("update");
    if (!locked) return false;
    const current = ((locked.metadata as Record<string, unknown> | null)
      ?.importRead ?? {}) as StoredLibraryRead;
    if (yieldToRead && current.status === "read") return false;
    const previous = Array.isArray(current.suggestedActions)
      ? current.suggestedActions
      : [];
    const merged: StoredLibraryRead = {
      ...next,
      suggestedActions: carryRunLibraryActions(previous, next.suggestedActions),
      ...(current.aiAt ? { aiAt: current.aiAt } : {}),
      // A billed read still to be finished survives a retry; any final
      // status (read, unreadable, …) ends it.
      ...(current.readCheckpoint && next.status === "not_read"
        ? { readCheckpoint: current.readCheckpoint }
        : {}),
    };
    await tx
      .update(documents)
      .set({
        metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importRead}', ${JSON.stringify(merged)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, itemId));
    return true;
  });
}

/**
 * Note an explicit re-read that did not read, beside the read the item keeps.
 * `false` = the item was deleted meanwhile (nothing written).
 */
export async function recordLastAttempt(
  database: LibraryReadDb,
  itemId: string,
  attempt: NonNullable<StoredLibraryRead["lastAttempt"]>
): Promise<boolean> {
  const rows = await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importRead,lastAttempt}', ${JSON.stringify(attempt)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, itemId), isNull(documents.deletedAt)))
    .returning({ id: documents.id });
  return rows.length > 0;
}

// ───────────────────────────── the item lease ─────────────────────────────

/** Where the lease lives on the item (beside `importRead`, which writers replace whole). */
const LEASE_KEY = "importReadLease";

/** What a job holds the item for: a read (with its reader), or a media retry. */
export interface ItemLeaseHolder {
  kind: "read" | "media";
  /** The reader an explicit read runs (absent = automatic). */
  reader?: string;
}

export type ItemLeaseClaim =
  | { ok: true; token: string }
  /** Another live job holds the item (`holder`), or the item is gone (`null`). */
  | { ok: false; holder: ItemLeaseHolder | null };

/**
 * Take the item's job LEASE, or learn who holds it. One conditional UPDATE
 * under the row lock: it succeeds only when no lease is held or the held one
 * has expired, so two jobs of one item never both win — the loser runs no
 * reader (no second vendor bill) and copies nothing. Times are the
 * database's own (`now()`), so pod clocks never disagree. `ttlSeconds` must
 * outlive the job's pg-boss expiry: a job pg-boss re-delivers while the first
 * still runs finds the lease held.
 */
export async function claimItemLease(
  database: LibraryReadDb,
  args: {
    itemId: string;
    userId: string;
    holder: ItemLeaseHolder;
    ttlSeconds: number;
  }
): Promise<ItemLeaseClaim> {
  const token = randomUUID();
  const lease = JSON.stringify({ token, ...args.holder });
  const won = await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), ${`{${LEASE_KEY}}`}::text[], ${lease}::jsonb || jsonb_build_object('until', (now() + make_interval(secs => ${args.ttlSeconds}))::text))`,
    })
    .where(
      and(
        eq(documents.id, args.itemId),
        eq(documents.userId, args.userId),
        isNull(documents.deletedAt),
        drizzleSql`(${documents.metadata} -> ${LEASE_KEY} IS NULL OR (${documents.metadata} #>> ${`{${LEASE_KEY},until}`}::text[])::timestamptz <= now())`
      )
    )
    .returning({ id: documents.id });
  if (won.length > 0) return { ok: true, token };
  const [row] = await database
    .select({
      lease: drizzleSql<unknown>`${documents.metadata} -> ${LEASE_KEY}`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, args.itemId),
        eq(documents.userId, args.userId),
        isNull(documents.deletedAt)
      )
    )
    .limit(1);
  const held = row?.lease as Record<string, unknown> | null | undefined;
  if (!row || !held || typeof held !== "object")
    return { ok: false, holder: null };
  return {
    ok: false,
    holder: {
      kind: held.kind === "media" ? "media" : "read",
      ...(typeof held.reader === "string" ? { reader: held.reader } : {}),
    },
  };
}

/** Give the lease back — only the holder's own token releases it. */
export async function releaseItemLease(
  database: LibraryReadDb,
  itemId: string,
  token: string
): Promise<void> {
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`${documents.metadata} - ${LEASE_KEY}`,
    })
    .where(
      and(
        eq(documents.id, itemId),
        drizzleSql`${documents.metadata} #>> ${`{${LEASE_KEY},token}`}::text[] = ${token}`
      )
    );
}
