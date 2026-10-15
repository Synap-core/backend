/**
 * The light read's doors onto the `library-light-read` queue:
 *   - `enqueueLibraryLightRead` — called when items enter the Library
 *     (`library.add`) and when a file is attached to a `needs_file` item;
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
import {
  defaultLightReadDeps,
  lightReadLibraryItem,
  type LightReadDeps,
} from "./light-read.js";
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
  options: { singletonKey: string; expireInSeconds: number }
) => Promise<unknown>;

async function defaultSend(): Promise<Send> {
  const { getBoss } = await import("@synap/jobs");
  const boss = getBoss();
  return (queue, data, options) => boss.send(queue, data, options);
}

/**
 * Queue a light read per item. One job per item at a time (`singletonKey`).
 * Returns how many were queued; a failed enqueue is logged and left to the
 * hourly sweep — the item is still `not_read`, never lost.
 */
export async function enqueueLibraryLightRead(
  items: ReadonlyArray<{
    userId: string;
    itemId: string;
    force?: boolean;
    /** The reader the person chose (`library.readWith`). */
    reader?: string;
  }>,
  send?: Send
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
        },
        { singletonKey: `library-light-read:${item.itemId}`, expireInSeconds }
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

/** The handler the api registers in the jobs slot at boot. */
export async function runLibraryLightReadJob(
  payload: LibraryLightReadPayload,
  opts: {
    database?: Pick<typeof DbType, "select"> & LibraryReadDb;
    deps?: LightReadDeps;
  } = {}
): Promise<LibraryLightReadResult> {
  const database =
    opts.database ?? ((await import("@synap/database")).db as never);
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
    database?: Pick<typeof DbType, "select" | "selectDistinct">;
    send?: Send;
    perDay?: number;
  } = {}
): Promise<{ enqueued: number }> {
  const database =
    opts.database ?? ((await import("@synap/database")).db as never);
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
        drizzleSql`(coalesce(${documents.metadata} #>> '{importRead,status}', 'not_read') = 'not_read' OR (${documents.metadata} #>> '{importRead,status}' = 'needs_file' AND ${documents.metadata} #>> '{importItem,source,documentId}' IS NOT NULL))`
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
  return { enqueued: await enqueueLibraryLightRead(due, opts.send) };
}
