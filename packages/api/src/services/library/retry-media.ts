/**
 * `library.retryMedia` — the person's "Try again" on "Couldn't keep the
 * pictures": the item's FAILED media copies (`metadata.importMediaFailures`)
 * are queued on the light-read queue as a media-only job (`media: "retry"`,
 * `retryLibraryItemMedia`): no reader runs, no read budget is spent.
 *
 * Person only (the tRPC door refuses an agent, like `readWith`). Honest: the
 * answer counts what was queued; a link that expired fails again and stays
 * said on the item (the client then points to "Read again", which fetches
 * fresh links). Owner-floored: a foreign or missing item is NOT_FOUND.
 */

import { TRPCError } from "@trpc/server";
import { db as defaultDb, documents, and, eq } from "@synap/database";
import type { LibraryRetryMediaResult } from "@synap-core/types/imports";
import { retryLibraryMediaPlan } from "../media-copy/library-media-record.js";
import { libraryItemsWhere, type LibraryDb } from "./read-model.js";

export interface LibraryRetryMediaDeps {
  enqueue(
    items: Array<{ userId: string; itemId: string; media: "retry" }>
  ): Promise<number>;
}

function defaultDeps(): LibraryRetryMediaDeps {
  return {
    async enqueue(items) {
      const { enqueueLibraryLightRead } = await import("./light-read-queue.js");
      return enqueueLibraryLightRead(items);
    },
  };
}

export async function libraryRetryMedia(args: {
  database?: LibraryDb;
  userId: string;
  itemId: string;
  deps?: Partial<LibraryRetryMediaDeps>;
}): Promise<LibraryRetryMediaResult> {
  const database = args.database ?? defaultDb;
  const deps = { ...defaultDeps(), ...args.deps };
  const [row] = await database
    .select({ metadata: documents.metadata })
    .from(documents)
    .where(and(libraryItemsWhere(args.userId), eq(documents.id, args.itemId)))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
  }
  const owed = retryLibraryMediaPlan(row.metadata).length;
  // Nothing failed: a true zero, nothing queued.
  if (owed === 0) return { queued: 0 };
  const queued = await deps.enqueue([
    { userId: args.userId, itemId: args.itemId, media: "retry" },
  ]);
  if (queued === 0) {
    // The queue is down: a tap that retried nothing must not look done.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The pictures could not be queued. Try again in a moment.",
    });
  }
  return { queued: owed };
}
