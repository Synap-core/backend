/**
 * The Library's READERS — which reader can read an item (or a list's waiting
 * items) and the person's one tap to read them with it.
 *
 *   - `libraryReaders` (`library.readers`, Hub `GET /library/readers`): the
 *     live offers of THE reader door (`listReadersForUrl`) for one item, or —
 *     for a group — folded over its WAITING items (needs a reader / title
 *     only / could not be read), one offer per reader with how many of them it
 *     reads. Never stored, so an install shows up at once and nothing goes
 *     stale. A failed lookup THROWS: "no reader" and "could not ask" are
 *     different facts.
 *   - `libraryReadWith` (`library.readWith`, person only — the tRPC door
 *     refuses an agent): the tap IS the consent. One light-read job per item,
 *     carrying `reader` (an explicit read: it may bill). A reader that bills
 *     the person's account takes one unit of the daily read budget per item;
 *     items past what today's budget holds are NOT queued and counted
 *     `overBudget` (nothing about them changes — the person taps again later).
 *
 * Owner-floored throughout (a foreign or missing id reads NOT_FOUND / is
 * skipped). The reader lookup runs in the item's own lens (its workspace).
 */

import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  documents,
  and,
  inArray,
  drizzleSql,
} from "@synap/database";
import type {
  LibraryReaderOffer,
  LibraryReadersResult,
  LibraryReadWithResult,
  ImportItemMetadata,
} from "@synap-core/types/imports";
import {
  readReaderStamp,
  type UrlReaderOffer,
} from "@synap-core/types/url-read";
import {
  BUILTIN_READER_ID as BUILTIN,
  type UrlReadersContext,
} from "../capabilities/url-readers.js";
import {
  inGroupSql,
  isArchivedSql,
  libraryItemsWhere,
  readStatusSql,
  type LibraryDb,
} from "./read-model.js";
import { loadLibraryGroup } from "./groups.js";
import {
  LIBRARY_READ_WINDOW_MS,
  libraryReadAiPerDay,
  libraryReadAiUsedToday,
} from "./read-budget.js";
import { isAgentCaller } from "./agent-door.js";

/** Read statuses a list's "Read N waiting with X" acts on. */
export const LIBRARY_WAITING_READ_STATUSES = [
  "needs_file",
  "title_only",
  "unreadable",
] as const;

/** Waiting items of one group a readers / readWith call looks at, at most. */
export const LIBRARY_READERS_SCAN_MAX = 1000;

export interface LibraryReadersDeps {
  listReaders(ctx: UrlReadersContext, url: string): Promise<UrlReaderOffer[]>;
  enqueue(
    items: Array<{
      userId: string;
      itemId: string;
      reader: string;
      force: true;
    }>
  ): Promise<number>;
  /** Items this person had read with AI in the rolling 24h. */
  usedToday(userId: string): Promise<number>;
  perDay(): number;
  now(): Date;
}

interface ReadableRow {
  id: string;
  workspaceId: string | null;
  metadata: unknown;
}

function urlOf(row: ReadableRow): string | null {
  const item = (row.metadata as Record<string, unknown> | null)?.importItem as
    ImportItemMetadata | undefined;
  const url = item?.source?.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/** Who is asking: an agent key / the IS internal key, or the person. */
export interface LibraryReadersCaller {
  agentUserId?: string | null;
  keyType?: string | null;
}

/**
 * A Library item is the PERSON's, whatever space it was kept in: for the
 * person its readers are every reader they can see (`allSpaces`), each run in
 * its own space — a pack installed in a space reads a pod-wide kept post. An
 * AGENT caller keeps the item's own lens: the acting agent is threaded and
 * `allSpaces` is off, so `readsAllSpaces` is false and an agent is never
 * offered readers from spaces it cannot run in.
 */
function ctxOf(
  userId: string,
  row: ReadableRow,
  caller: LibraryReadersCaller | undefined
): UrlReadersContext {
  if (caller && isAgentCaller(caller)) {
    return {
      userId,
      workspaceId: row.workspaceId,
      agentUserId: caller.agentUserId ?? null,
      allSpaces: false,
    };
  }
  return { userId, workspaceId: row.workspaceId, allSpaces: true };
}

const COLUMNS = {
  id: documents.id,
  workspaceId: documents.workspaceId,
  metadata: documents.metadata,
};

async function itemRows(
  database: LibraryDb,
  userId: string,
  ids: readonly string[]
): Promise<ReadableRow[]> {
  if (ids.length === 0) return [];
  return database
    .select(COLUMNS)
    .from(documents)
    .where(and(libraryItemsWhere(userId), inArray(documents.id, [...ids])));
}

/** A group's waiting items (owner-floored; NOT_FOUND for a foreign group). */
async function waitingRows(
  database: LibraryDb,
  userId: string,
  groupId: string
): Promise<ReadableRow[]> {
  await loadLibraryGroup({ database, userId, groupId });
  return database
    .select(COLUMNS)
    .from(documents)
    .where(
      and(
        libraryItemsWhere(userId),
        inGroupSql(groupId),
        drizzleSql`NOT ${isArchivedSql}`,
        drizzleSql`${readStatusSql} IN (${drizzleSql.join(
          LIBRARY_WAITING_READ_STATUSES.map((s) => drizzleSql`${s}`),
          drizzleSql`, `
        )})`
      )
    )
    .orderBy(documents.createdAt)
    .limit(LIBRARY_READERS_SCAN_MAX);
}

/** The offer id that produced a stored read (`builtin:<rung>` → `builtin`). */
function readerIdOfStamp(metadata: unknown): string | null {
  const stamp = readReaderStamp(
    (
      (metadata as Record<string, unknown> | null)?.importRead as
        Record<string, unknown> | undefined
    )?.reader
  );
  if (!stamp) return null;
  return stamp.id === BUILTIN || stamp.id.startsWith(`${BUILTIN}:`)
    ? BUILTIN
    : stamp.id;
}

/** `library.readers` — live offers for one item, or a group's waiting items. */
export async function libraryReaders(args: {
  database?: LibraryDb;
  userId: string;
  itemId?: string;
  groupId?: string;
  /** The caller's identity — an agent's offers stay in the item's lens. */
  caller?: LibraryReadersCaller;
  deps?: Partial<LibraryReadersDeps>;
}): Promise<LibraryReadersResult> {
  const database = args.database ?? defaultDb;
  const deps = { ...defaultLibraryReadersDeps(), ...args.deps };
  if (args.itemId) {
    const [row] = await itemRows(database, args.userId, [args.itemId]);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
    }
    const url = urlOf(row);
    // Nothing reads a typed note or a file: an empty answer that is TRUE.
    if (!url) return { offers: [] };
    const current = readerIdOfStamp(row.metadata);
    const offers = await deps.listReaders(
      ctxOf(args.userId, row, args.caller),
      url
    );
    return {
      offers: offers.map((o) =>
        current && o.readerId === current ? { ...o, current: true } : o
      ),
    };
  }
  if (!args.groupId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Name an item or a group.",
    });
  }
  const rows = (await waitingRows(database, args.userId, args.groupId)).filter(
    (r) => urlOf(r) !== null
  );
  const byReader = new Map<string, LibraryReaderOffer>();
  for (const row of rows) {
    // Throws on a failed lookup — never folded into "no readers".
    const offers = await deps.listReaders(
      ctxOf(args.userId, row, args.caller),
      urlOf(row)!
    );
    for (const o of offers) {
      const seen = byReader.get(o.readerId);
      if (seen) seen.count = (seen.count ?? 0) + 1;
      else {
        const { current: _current, ...offer } = o;
        byReader.set(o.readerId, { ...offer, count: 1 });
      }
    }
  }
  // Most items first; ties keep the door's own ranking (first seen).
  const offers = [...byReader.values()].sort(
    (a, b) => (b.count ?? 0) - (a.count ?? 0)
  );
  return { offers, waiting: rows.length };
}

/** `library.readWith` — one job per item with the chosen reader (the tap is the consent). */
export async function libraryReadWith(args: {
  database?: LibraryDb;
  userId: string;
  itemIds?: readonly string[];
  groupId?: string;
  readerId: string;
  deps?: Partial<LibraryReadersDeps>;
}): Promise<LibraryReadWithResult> {
  const database = args.database ?? defaultDb;
  const deps = { ...defaultLibraryReadersDeps(), ...args.deps };
  let rows: ReadableRow[];
  let skipped = 0;
  if (args.itemIds?.length) {
    const ids = [...new Set(args.itemIds)];
    rows = await itemRows(database, args.userId, ids);
    skipped += ids.length - rows.length; // foreign, deleted or unknown
  } else if (args.groupId) {
    rows = await waitingRows(database, args.userId, args.groupId);
  } else {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Name items or a group.",
    });
  }

  const now = deps.now().getTime();
  let room: number | null = null; // computed on the first billed item
  const due: Array<{
    userId: string;
    itemId: string;
    reader: string;
    force: true;
  }> = [];
  let overBudget = 0;
  for (const row of rows) {
    const url = urlOf(row);
    if (!url) {
      skipped++;
      continue;
    }
    // readWith is person-only (the tRPC door refuses an agent first).
    const offer = (
      await deps.listReaders(ctxOf(args.userId, row, undefined), url)
    ).find((o) => o.readerId === args.readerId);
    // Only a reader that can run now: install / connect / enable are their
    // own doors (the offer says which), not N jobs that would each say so.
    if (!offer || offer.state !== "ready") {
      skipped++;
      continue;
    }
    if (offer.billing === "account" && !holdsFreshUnit(row.metadata, now)) {
      if (room === null) {
        room = Math.max(deps.perDay() - (await deps.usedToday(args.userId)), 0);
      }
      if (room <= 0) {
        overBudget++;
        continue;
      }
      room--;
    }
    due.push({
      userId: args.userId,
      itemId: row.id,
      reader: args.readerId,
      force: true,
    });
  }
  const queued = due.length > 0 ? await deps.enqueue(due) : 0;
  if (due.length > 0 && queued === 0) {
    // The queue is down: say so — a tap that read nothing must not look done.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The reads could not be queued. Try again in a moment.",
    });
  }
  return { queued, overBudget, skipped };
}

/** An item already stamped inside the 24h window reuses its unit (read-budget.ts). */
function holdsFreshUnit(metadata: unknown, now: number): boolean {
  const aiAt = (
    (metadata as Record<string, unknown> | null)?.importRead as
      Record<string, unknown> | undefined
  )?.aiAt;
  if (typeof aiAt !== "string") return false;
  const at = Date.parse(aiAt);
  return Number.isFinite(at) && at >= now - LIBRARY_READ_WINDOW_MS;
}

export function defaultLibraryReadersDeps(): LibraryReadersDeps {
  return {
    async listReaders(ctx, url) {
      const { listReadersForUrl } =
        await import("../capabilities/url-readers.js");
      return listReadersForUrl(ctx, url);
    },
    async enqueue(items) {
      const { enqueueLibraryLightRead } = await import("./light-read-queue.js");
      return enqueueLibraryLightRead(items);
    },
    usedToday: (userId) => libraryReadAiUsedToday(defaultDb, userId),
    perDay: () => libraryReadAiPerDay(),
    now: () => new Date(),
  };
}
