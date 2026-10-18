/**
 * The light read's doors onto the `library-light-read` queue:
 *   - `enqueueLibraryLightRead` — called when items enter the Library
 *     (`library.add`), when a file is attached to a `needs_file` item, and
 *     for a person's "Try again" on an item's pictures (`media: "retry"`,
 *     `library.retryMedia` — the copy door only, no read);
 *   - `runLibraryLightReadJob` — the handler the api puts in the jobs slot;
 *   - `sweepLibraryLightReads` — the hourly re-enqueue of items not read yet
 *     or held over budget (only for people whose budget has room again).
 *
 * The queue name is owned by `@synap/jobs` (`library-light-read-worker.ts`).
 */

import { isArchivedSql, lightReadEligibleSql } from "./read-model.js";
import { createLogger } from "@synap-core/core";
import { envInt } from "@synap/shared-utils";
import {
  documents,
  drizzleSql,
  and,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import type { db as DbType } from "@synap/database";
import {
  LIBRARY_LIGHT_READ_QUEUE,
  type LibraryLightReadPayload,
  type LibraryLightReadResult,
} from "@synap/jobs/workers/library-light-read-worker.js";
import { lightReadLibraryItem } from "./light-read.js";
import { defaultLightReadDeps, type LightReadDeps } from "./light-read-deps.js";
import {
  claimItemLease,
  releaseItemLease,
  type ItemLeaseHolder,
} from "./light-read-store.js";
import {
  expireLibraryReadConsents,
  libraryReadConsentDays,
} from "./read-consent.js";
import {
  libraryReadAiPerDay,
  libraryReadAiUsedToday,
  type LibraryReadDb,
} from "./read-budget.js";

const logger = createLogger({ module: "library/light-read-queue" });

/** Items one sweep re-enqueues at most (oldest first). */
export const LIGHT_READ_SWEEP_BATCH = 200;

/**
 * How long one light-read job may run before pg-boss expires it, in minutes
 * (env `SYNAP_LIBRARY_LIGHT_READ_EXPIRE_MINUTES`, default 60, 5–720).
 *
 * pg-boss's default is 15 minutes, and on expiry it re-queues the job as a
 * retry WHILE the first handler is still running. A light read copies the
 * item's media in the same job — a video streams up to 1 GiB with a 30-minute
 * cap of its own (`VIDEO_TOTAL_TIMEOUT_MS`) — so a big copy outlived the
 * default and ran twice. Sized for the copy plus the read, transcript and
 * summary around it. A billed read is never re-run by such a retry either way:
 * it is checkpointed on the item before the copy (`importRead.readCheckpoint`).
 */
export const LIGHT_READ_JOB_EXPIRE_MINUTES_DEFAULT = 60;

export function lightReadJobExpireSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  const minutes = envInt(env, "SYNAP_LIBRARY_LIGHT_READ_EXPIRE_MINUTES", {
    default: LIGHT_READ_JOB_EXPIRE_MINUTES_DEFAULT,
    min: 5,
    max: 720,
  });
  return minutes * 60;
}

type Send = (
  queue: string,
  data: LibraryLightReadPayload,
  options: {
    singletonKey: string;
    expireInSeconds: number;
    /** Seconds to wait before the job may start (a re-queued explicit read). */
    startAfter?: number;
  }
) => Promise<unknown>;

/**
 * How long a job's item lease lives: past the job's own pg-boss expiry, so a
 * job pg-boss re-delivers while the first still runs finds the item held.
 */
export function lightReadLeaseSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  return lightReadJobExpireSeconds(env) + LEASE_MARGIN_SECONDS;
}
const LEASE_MARGIN_SECONDS = 5 * 60;
/** Wait before an explicit read that found its item busy with ANOTHER reader runs. */
export const LIGHT_READ_BUSY_REQUEUE_SECONDS = 60;

async function defaultSend(): Promise<Send> {
  const { getBoss } = await import("@synap/jobs");
  const boss = getBoss();
  return (queue, data, options) => boss.send(queue, data, options);
}

/**
 * Queue a light read per item. Returns how many were queued; a failed
 * enqueue is logged and left to the hourly sweep — the item is still
 * `not_read`, never lost.
 *
 * The `singletonKey` does NOT make it one job per item: on a standard pg-boss
 * v10 queue a bare singletonKey is never enforced. What keeps two jobs of one
 * item from reading it at once is the item LEASE the handler takes
 * (`claimItemLease`, {@link runLibraryLightReadJob}).
 */
export async function enqueueLibraryLightRead(
  items: ReadonlyArray<{
    userId: string;
    itemId: string;
    force?: boolean;
    /** The reader the person chose (`library.readWith`). */
    reader?: string;
    /** Copy the item's failed media again, nothing else (`library.retryMedia`). */
    media?: "retry";
    /** With `reader`: keep an existing read, only add media (`missingMedia`). */
    keepRead?: boolean;
    /** With `reader`: the reader's declared `withVideo` choice. */
    withVideo?: boolean;
  }>,
  send?: Send,
  opts: { startAfter?: number } = {}
): Promise<number> {
  if (items.length === 0) return 0;
  let sendFn: Send;
  try {
    sendFn = send ?? (await defaultSend());
  } catch (err) {
    logger.warn(
      { err, count: items.length },
      "library light read: queue unavailable — the hourly sweep will read these"
    );
    return 0;
  }
  let queued = 0;
  const expireInSeconds = lightReadJobExpireSeconds();
  for (const item of items) {
    try {
      await sendFn(
        LIBRARY_LIGHT_READ_QUEUE,
        {
          userId: item.userId,
          itemId: item.itemId,
          ...(item.force ? { force: true } : {}),
          ...(item.reader ? { reader: item.reader } : {}),
          ...(item.media ? { media: item.media } : {}),
          ...(item.reader && item.keepRead ? { keepRead: true } : {}),
          ...(item.reader && item.withVideo ? { withVideo: true } : {}),
        },
        {
          singletonKey: `library-${item.media ? "media-retry" : "light-read"}:${item.itemId}`,
          expireInSeconds,
          ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
        }
      );
      queued++;
    } catch (err) {
      logger.warn(
        { err, itemId: item.itemId },
        "library light read: enqueue failed — the hourly sweep will read it"
      );
    }
  }
  return queued;
}

/**
 * The handler the api puts in the jobs slot at boot.
 *
 * ONE job per item at a time, for real: the job first takes the item's lease
 * (`claimItemLease`, a row-level claim that outlives the job's expiry). A job
 * that finds the item held runs nothing — no reader, no vendor bill, no
 * download — and answers `skipped` + `busy`:
 *   - the same work is already running (an automatic read, the same reader
 *     tapped twice, a list tap overlapping an item tap, a media retry tapped
 *     twice): nothing more to do;
 *   - an explicit read with a DIFFERENT reader than the holder's: the person
 *     asked for it, so it is queued again shortly
 *     ({@link LIGHT_READ_BUSY_REQUEUE_SECONDS}) and runs after the holder.
 */
export async function runLibraryLightReadJob(
  payload: LibraryLightReadPayload,
  opts: LightReadJobOptions = {}
): Promise<LibraryLightReadResult> {
  const database =
    opts.database ?? ((await import("@synap/database")).db as never);
  const holder: ItemLeaseHolder =
    payload.media === "retry"
      ? { kind: "media" }
      : { kind: "read", ...(payload.reader ? { reader: payload.reader } : {}) };
  const claim = await claimItemLease(database, {
    itemId: payload.itemId,
    userId: payload.userId,
    holder,
    ttlSeconds: lightReadLeaseSeconds(),
  });
  if (!claim.ok) {
    if (!claim.holder) return { itemId: payload.itemId, status: "skipped" };
    const otherReader =
      holder.kind === "read" &&
      !!holder.reader &&
      (claim.holder.kind !== "read" || claim.holder.reader !== holder.reader);
    if (otherReader) {
      await enqueueLibraryLightRead(
        [
          {
            userId: payload.userId,
            itemId: payload.itemId,
            ...(payload.force ? { force: true } : {}),
            reader: holder.reader,
            ...(payload.keepRead ? { keepRead: true } : {}),
            ...(payload.withVideo ? { withVideo: true } : {}),
          },
        ],
        opts.send,
        { startAfter: LIGHT_READ_BUSY_REQUEUE_SECONDS }
      );
    }
    logger.info(
      { itemId: payload.itemId, holder: claim.holder, requeued: otherReader },
      "library light read: item busy with another job — nothing run"
    );
    return { itemId: payload.itemId, status: "skipped", busy: true };
  }
  try {
    return await runClaimedJob(payload, database, opts);
  } finally {
    await releaseItemLease(database, payload.itemId, claim.token).catch(
      (err: unknown) =>
        logger.warn(
          { err, itemId: payload.itemId },
          "library light read: lease NOT released — it lapses on its own"
        )
    );
  }
}

interface LightReadJobOptions {
  database?: Pick<typeof DbType, "select"> & LibraryReadDb;
  deps?: LightReadDeps;
  /** Test seam: the media retry (`retryLibraryItemMedia`). */
  retryMedia?: (input: {
    userId: string;
    itemId: string;
  }) => Promise<{ status: string }>;
  /** Test seam: the re-queue of an explicit read that found the item busy. */
  send?: Send;
}

async function runClaimedJob(
  payload: LibraryLightReadPayload,
  database: Pick<typeof DbType, "select"> & LibraryReadDb,
  opts: LightReadJobOptions
): Promise<LibraryLightReadResult> {
  if (payload.media === "retry") {
    // The person's "Try again" on the pictures: the copy door only.
    const out = await (
      opts.retryMedia ??
      (async (input: { userId: string; itemId: string }) =>
        (
          await import("../media-copy/copy-library-item-media.js")
        ).retryLibraryItemMedia(input))
    )({ userId: payload.userId, itemId: payload.itemId });
    return {
      itemId: payload.itemId,
      status: `media_${out.status}`,
    };
  }
  let deps = opts.deps;
  if (!deps) {
    const [row] = await database
      .select({ workspaceId: documents.workspaceId })
      .from(documents)
      .where(
        and(
          eq(documents.id, payload.itemId),
          eq(documents.userId, payload.userId)
        )
      )
      .limit(1);
    deps = defaultLightReadDeps({
      database,
      userId: payload.userId,
      workspaceId: row?.workspaceId ?? null,
    });
  }
  return lightReadLibraryItem({
    database,
    userId: payload.userId,
    itemId: payload.itemId,
    ...(payload.force ? { force: true } : {}),
    ...(payload.reader ? { reader: payload.reader } : {}),
    ...(payload.reader && payload.keepRead ? { keepRead: true } : {}),
    ...(payload.reader && payload.withVideo ? { withVideo: true } : {}),
    deps,
  });
}

/**
 * Re-enqueue what is still waiting: never read (`importRead` absent or
 * `not_read`), a `needs_file` item whose file has since been attached, and
 * `over_budget` items of people whose 24h window has room.
 * Archived items wait until they are opened again.
 */
export async function sweepLibraryLightReads(
  opts: {
    database?: Pick<typeof DbType, "select" | "selectDistinct" | "update">;
    send?: Send;
    perDay?: number;
    /** Consent days (`SYNAP_LIBRARY_READ_CONSENT_DAYS`). */
    consentDays?: number;
  } = {}
): Promise<{ enqueued: number; consentsEnded: number }> {
  const database =
    opts.database ?? ((await import("@synap/database")).db as never);
  // 0. A "Read with X" consent that has ENDED is forgotten before anything is
  //    picked: its item goes back to waiting for a reader, and is never queued
  //    to run that reader (`read-consent.ts`).
  const ended = await expireLibraryReadConsents(
    database,
    opts.consentDays ?? libraryReadConsentDays()
  );
  for (const row of ended) {
    notifyItem(row);
  }
  const base = and(
    isNull(documents.deletedAt),
    drizzleSql`${documents.metadata} ? 'importItem'`,
    drizzleSql`NOT ${isArchivedSql}`,
    // ROLLOUT: only items kept through a Library door (or already in the read
    // pipeline). The backlog of old import items is never bulk-read — it stays
    // title-only until the person opens it (`item.seen`) or asks Read now.
    lightReadEligibleSql,
    // Leave a fresh save to the enqueue that came with it.
    drizzleSql`${documents.createdAt} < now() - interval '2 minutes'`
  );
  // 1. What no budget holds back: never read, or a needs_file item whose file
  //    has since been attached.
  const fresh = await database
    .select({ id: documents.id, userId: documents.userId })
    .from(documents)
    .where(
      and(
        base,
        // A read waiting after a failure is due once its wait is over
        // (`failure.nextAttemptAt`: transient failures back off).
        drizzleSql`((coalesce(${documents.metadata} #>> '{importRead,status}', 'not_read') = 'not_read' AND (${documents.metadata} #>> '{importRead,failure,nextAttemptAt}' IS NULL OR (${documents.metadata} #>> '{importRead,failure,nextAttemptAt}')::timestamptz <= now())) OR (${documents.metadata} #>> '{importRead,status}' = 'needs_file' AND ${documents.metadata} #>> '{importItem,source,documentId}' IS NOT NULL))`
      )
    )
    .orderBy(documents.createdAt)
    .limit(LIGHT_READ_SWEEP_BATCH);
  const due: Array<{ userId: string; itemId: string }> = fresh.map((r) => ({
    userId: r.userId,
    itemId: r.id,
  }));

  // 2. Held over budget — only for the people whose window has room, chosen
  //    BEFORE the limit: one person's pile of held items can never fill the
  //    batch and starve everyone else.
  const room = LIGHT_READ_SWEEP_BATCH - due.length;
  if (room > 0) {
    const overBudget = drizzleSql`${documents.metadata} #>> '{importRead,status}' = 'over_budget'`;
    const holders = await database
      .selectDistinct({ userId: documents.userId })
      .from(documents)
      .where(and(base, overBudget));
    const perDay = opts.perDay ?? libraryReadAiPerDay();
    const withRoom: string[] = [];
    for (const h of holders) {
      if ((await libraryReadAiUsedToday(database, h.userId)) < perDay) {
        withRoom.push(h.userId);
      }
    }
    if (withRoom.length > 0) {
      const held = await database
        .select({ id: documents.id, userId: documents.userId })
        .from(documents)
        .where(and(base, overBudget, inArray(documents.userId, withRoom)))
        .orderBy(documents.createdAt)
        .limit(room);
      for (const r of held) due.push({ userId: r.userId, itemId: r.id });
    }
  }
  return {
    enqueued: await enqueueLibraryLightRead(due, opts.send),
    consentsEnded: ended.length,
  };
}

/** Tell the owner an item changed (fire-and-forget, the realtime door). */
function notifyItem(row: { id: string; userId: string; metadata: unknown }) {
  void import("../../utils/event-emit.js")
    .then(({ emitLibraryItemUpdated }) =>
      emitLibraryItemUpdated({
        userId: row.userId,
        itemId: row.id,
        metadata: row.metadata,
        what: "read",
      })
    )
    .catch(() => undefined);
}
