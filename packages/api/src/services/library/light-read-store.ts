/**
 * The light read's stored state: `documents.metadata.importRead` as the pod
 * keeps it (the contract plus bookkeeping), and its three writers — the
 * billed-read checkpoint, the read itself (under a row lock, keeping chips run
 * meanwhile) and an explicit re-read's last attempt.
 */

import { documents, drizzleSql, eq } from "@synap/database";
import {
  carryRunLibraryActions,
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
  /** IS / reader failures so far. */
  attempts?: number;
  /** The last failed read's error (kept when it ends `unreadable`). */
  lastError?: string;
  /**
   * The reader the person chose for a read that has not happened yet (over
   * budget, or failed and waiting for its retry): the sweep's job reads with
   * it, so a retry never silently falls back to the free reader.
   */
  requestedReader?: string;
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
    .where(eq(documents.id, itemId));
}

/** Write the new read into the bag, keeping chips run meanwhile. */
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
      .where(eq(documents.id, itemId))
      .for("update");
    const current = ((locked?.metadata as Record<string, unknown> | null)
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

/** Note an explicit re-read that did not read, beside the read the item keeps. */
export async function recordLastAttempt(
  database: LibraryReadDb,
  itemId: string,
  attempt: NonNullable<StoredLibraryRead["lastAttempt"]>
): Promise<void> {
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{importRead,lastAttempt}', ${JSON.stringify(attempt)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, itemId));
}
