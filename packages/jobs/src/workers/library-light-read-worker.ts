/**
 * Library light read — the cheap read every Library item gets on save.
 *
 * Two queues, both handler SLOTS filled by the api layer at boot (the one-way
 * `api → jobs` dependency: jobs never imports the readers, the IS client or
 * the budget — same IoC as `import-corpus-worker.ts`):
 *
 *   - `library-light-read`       one item: read its text (page / file / OCR /
 *     transcript), summarise it, detect action chips, write
 *     `documents.metadata.importRead`, index it. Enqueued by `library.add` and
 *     when a file is attached to a `needs_file` item.
 *   - `library-light-read-sweep` hourly: re-enqueues items still `not_read`
 *     (a lost enqueue) or `over_budget` (the day's AI budget has room again).
 *     "Over budget" is a mark that is read later, never a silent drop.
 *
 * The handler owns its failures: an unreadable item is MARKED `unreadable`,
 * it does not throw (a retry would spend the AI budget again). It throws only
 * when the pod itself failed (a database write), where a retry is right.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { envInt } from "@synap/shared-utils";

const logger = createLogger({ module: "library-light-read-worker" });

export const LIBRARY_LIGHT_READ_QUEUE = "library-light-read";
export const LIBRARY_LIGHT_READ_SWEEP_QUEUE = "library-light-read-sweep";
/** Hourly, at minute 17 (off the :00 pile-up). */
export const LIBRARY_LIGHT_READ_SWEEP_CRON = "17 * * * *";

export interface LibraryLightReadPayload {
  userId: string;
  /** The staged item (a document carrying `metadata.importItem`). */
  itemId: string;
  /** Read again even when a final read is on the item. */
  force?: boolean;
  /**
   * The reader the person chose ("Read with X", `library.readWith`): a reader
   * id from the item's offers (`"builtin"` or a verb id). Implies `force`,
   * may bill (one unit of the daily read budget) and is interactive. Absent =
   * the automatic read (the best FREE ready reader).
   */
  reader?: string;
  /**
   * `"retry"`: no read at all — copy again the media the item failed to
   * copy (the person's "Try again", `library.retryMedia`). No reader runs and
   * no read budget is spent.
   */
  media?: "retry";
  /**
   * With `reader`: an item that already HAS a read keeps it — only the media
   * this read returns is copied (`library.readWith({ missingMedia: true })`,
   * the pictures of an old post whose links expired).
   */
  keepRead?: boolean;
  /**
   * With `reader`: the person's per-tap choice to download the video too
   * (`withVideo`). Set only when the reader declares it.
   */
  withVideo?: boolean;
}

/**
 * Workers on the light-read queue (env `SYNAP_LIBRARY_LIGHT_READ_CONCURRENCY`,
 * default 4, 1–16): a hosted reader (an Apify run) can take up to 120 s, so
 * one worker would serialize a bulk "Read N with X". pg-boss v10 has no
 * `localConcurrency` — concurrency is N `work()` registrations.
 */
export const LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT = 4;

export function libraryLightReadConcurrency(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(env, "SYNAP_LIBRARY_LIGHT_READ_CONCURRENCY", {
    default: LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT,
    min: 1,
    max: 16,
  });
}

/** What one read did — stored as the pg-boss job `output`. */
export interface LibraryLightReadResult {
  itemId: string;
  /** `skipped` = nothing to do (gone, not a Library item, already read, busy). */
  status: string;
  /** Another job held the item (its lease): nothing was run. */
  busy?: boolean;
  chars?: number;
  actions?: number;
  usedAi?: boolean;
}

export interface LibraryLightReadSweepResult {
  enqueued: number;
}

type ReadHandler = (
  p: LibraryLightReadPayload
) => Promise<LibraryLightReadResult>;
type SweepHandler = () => Promise<LibraryLightReadSweepResult>;

let readHandler: ReadHandler | null = null;
let sweepHandler: SweepHandler | null = null;

export function registerLibraryLightReadHandler(fn: ReadHandler): void {
  readHandler = fn;
}

export function registerLibraryLightReadSweepHandler(fn: SweepHandler): void {
  sweepHandler = fn;
}

export async function handleLibraryLightRead(
  job: PgBoss.Job<LibraryLightReadPayload>
): Promise<LibraryLightReadResult> {
  if (!readHandler)
    throw new Error("library-light-read handler not registered");
  const startedAt = Date.now();
  const result = await readHandler(job.data);
  logger.info(
    {
      itemId: job.data.itemId,
      reader: job.data.reader ?? null,
      status: result.status,
      chars: result.chars ?? null,
      actions: result.actions ?? null,
      usedAi: result.usedAi ?? false,
      durationMs: Date.now() - startedAt,
    },
    "Library light read"
  );
  return result;
}

export async function handleLibraryLightReadSweep(): Promise<LibraryLightReadSweepResult> {
  if (!sweepHandler) {
    // Boot order: the cron can fire before the api filled the slot. Nothing is
    // lost — the next sweep picks the same items up.
    logger.warn(
      "library-light-read-sweep handler not registered yet — skipped"
    );
    return { enqueued: 0 };
  }
  const result = await sweepHandler();
  if (result.enqueued > 0) {
    logger.info(result, "Library light read sweep re-enqueued items");
  }
  return result;
}
