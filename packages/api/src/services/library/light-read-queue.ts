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

import { createLogger } from "@synap-core/core";
import { documents, drizzleSql, and, eq, isNull } from "@synap/database";
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

type Send = (
  queue: string,
  data: LibraryLightReadPayload,
  options: { singletonKey: string }
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
  items: ReadonlyArray<{ userId: string; itemId: string; force?: boolean }>,
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
  for (const item of items) {
    try {
      await sendFn(
        LIBRARY_LIGHT_READ_QUEUE,
        {
          userId: item.userId,
          itemId: item.itemId,
          ...(item.force ? { force: true } : {}),
        },
        { singletonKey: `library-light-read:${item.itemId}` }
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
    database?: Pick<typeof DbType, "select">;
    send?: Send;
    perDay?: number;
  } = {}
): Promise<{ enqueued: number }> {
  const database =
    opts.database ?? ((await import("@synap/database")).db as never);
  const rows = await database
    .select({
      id: documents.id,
      userId: documents.userId,
      status: drizzleSql<
        string | null
      >`${documents.metadata} #>> '{importRead,status}'`,
    })
    .from(documents)
    .where(
      and(
        isNull(documents.deletedAt),
        drizzleSql`${documents.metadata} ? 'importItem'`,
        drizzleSql`(coalesce(${documents.metadata} #>> '{importRead,status}', 'not_read') in ('not_read', 'over_budget') OR (${documents.metadata} #>> '{importRead,status}' = 'needs_file' AND ${documents.metadata} #>> '{importItem,source,documentId}' IS NOT NULL))`,
        drizzleSql`(${documents.metadata} #>> '{importCuration,archivedAt}') IS NULL`,
        // Leave a fresh save to the enqueue that came with it.
        drizzleSql`${documents.createdAt} < now() - interval '2 minutes'`
      )
    )
    .orderBy(documents.createdAt)
    .limit(LIGHT_READ_SWEEP_BATCH);

  const perDay = opts.perDay ?? libraryReadAiPerDay();
  const roomByUser = new Map<string, boolean>();
  const due: Array<{ userId: string; itemId: string }> = [];
  for (const r of rows) {
    if (r.status === "over_budget") {
      let room = roomByUser.get(r.userId);
      if (room === undefined) {
        room = (await libraryReadAiUsedToday(database, r.userId)) < perDay;
        roomByUser.set(r.userId, room);
      }
      if (!room) continue;
    }
    due.push({ userId: r.userId, itemId: r.id });
  }
  return { enqueued: await enqueueLibraryLightRead(due, opts.send) };
}
