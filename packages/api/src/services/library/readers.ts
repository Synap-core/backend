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
 *     items past what today's budget holds are NOT queued, counted
 *     `overBudget` and marked `over_budget` with the chosen reader, which the
 *     hourly sweep reads once the budget has room (a `read` item keeps its read).
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
import {
  readLibraryItemRead,
  type LibraryReaderOffer,
  type LibraryReadersResult,
  type LibraryReadWithResult,
  type ImportItemMetadata,
} from "@synap-core/types/imports";
import { createLogger } from "@synap-core/core";
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
  type LibraryReaderAvailability,
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

const logger = createLogger({ module: "library/readers" });

export interface LibraryReadersDeps {
  listReaders(ctx: UrlReadersContext, url: string): Promise<UrlReaderOffer[]>;
  /** One source load per lens, then a pure fold per URL (`urlReaderLookup`). */
  readerLookup(
    ctx: UrlReadersContext
  ): Promise<(url: string) => UrlReaderOffer[]>;
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

/**
 * WAITING items (needs a reader / title only / could not be read; not
 * archived, not deleted), oldest first, at most {@link LIBRARY_READERS_SCAN_MAX}:
 * a group's (owner-floored; NOT_FOUND for a foreign group), or — no group —
 * the person's whole Library.
 */
async function waitingRows(
  database: LibraryDb,
  userId: string,
  groupId?: string
): Promise<ReadableRow[]> {
  if (groupId) await loadLibraryGroup({ database, userId, groupId });
  return database
    .select(COLUMNS)
    .from(documents)
    .where(
      and(
        libraryItemsWhere(userId),
        ...(groupId ? [inGroupSql(groupId)] : []),
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

/**
 * The reader offers of many rows: the sources load ONCE per lens (the row's
 * space — the person's lens and an agent's alike are keyed by it), then a
 * pure fold per URL (`urlReaderLookup`: "N links cost one source load").
 * A lookup that fails throws — never folded into "no readers".
 */
async function offersByRow(
  rows: readonly ReadableRow[],
  userId: string,
  caller: LibraryReadersCaller | undefined,
  deps: LibraryReadersDeps
): Promise<Map<string, UrlReaderOffer[]>> {
  const lookups = new Map<string | null, (url: string) => UrlReaderOffer[]>();
  const out = new Map<string, UrlReaderOffer[]>();
  for (const row of rows) {
    const url = urlOf(row);
    if (!url) continue;
    let lookup = lookups.get(row.workspaceId);
    if (!lookup) {
      lookup = await deps.readerLookup(ctxOf(userId, row, caller));
      lookups.set(row.workspaceId, lookup);
    }
    out.set(row.id, lookup(url));
  }
  return out;
}

/**
 * `library.readers` — live offers for one item, or for many WAITING items
 * (a group's, or with `waiting` the whole Library's), one offer per reader
 * with the `count` of those items it reads.
 */
export async function libraryReaders(args: {
  database?: LibraryDb;
  userId: string;
  itemId?: string;
  groupId?: string;
  /** Every waiting item of the person's Library (no group). */
  waiting?: boolean;
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
  if (!args.groupId && !args.waiting) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Name an item, a group, or the waiting items.",
    });
  }
  const rows = (await waitingRows(database, args.userId, args.groupId)).filter(
    (r) => urlOf(r) !== null
  );
  // Throws on a failed lookup — never folded into "no readers".
  const offersOf = await offersByRow(rows, args.userId, args.caller, deps);
  const byReader = new Map<string, LibraryReaderOffer>();
  for (const row of rows) {
    for (const o of offersOf.get(row.id) ?? []) {
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

/**
 * The rows' "a reader can serve this" bit (`LibraryItemView.readerAvailable`),
 * for a page of items: only WEAK reads (needs a reader / title only / could
 * not be read) with a link are asked, and the reader sources are loaded ONCE
 * per lens (the item's space — almost always one per page) and folded per URL
 * in memory — never one registry read per row. The rule is the preview's:
 * an offer exists that did NOT produce the stored read (the door's own
 * `!current`), installed (ready / enable / connect) or to install from the
 * catalog — so the row and the open preview say the same thing.
 *
 * A lens whose lookup FAILED leaves its items without the bit (unknown, the
 * client keeps its plain mark) and is logged — never written as `false`.
 */
export function libraryReaderAvailability(args: {
  userId: string;
  caller?: LibraryReadersCaller;
  deps?: Partial<LibraryReadersDeps>;
}): LibraryReaderAvailability {
  const deps = { ...defaultLibraryReadersDeps(), ...args.deps };
  return async (rows) => {
    const out = new Map<string, boolean>();
    const byLens = new Map<string | null, ReadableRow[]>();
    for (const row of rows) {
      const url = urlOf(row);
      if (!url) continue;
      const item = (row.metadata as Record<string, unknown> | null)
        ?.importItem as ImportItemMetadata | undefined;
      const status = readLibraryItemRead(
        row.metadata,
        item?.contentStatus
      ).status;
      if (
        !(LIBRARY_WAITING_READ_STATUSES as readonly string[]).includes(status)
      ) {
        continue;
      }
      const lens = byLens.get(row.workspaceId) ?? [];
      lens.push(row);
      byLens.set(row.workspaceId, lens);
    }
    for (const lensRows of byLens.values()) {
      let lookup: (url: string) => UrlReaderOffer[];
      try {
        lookup = await deps.readerLookup(
          ctxOf(args.userId, lensRows[0]!, args.caller)
        );
      } catch (err) {
        logger.warn(
          { err, items: lensRows.length },
          "library readers: the reader lookup failed — rows keep their plain mark"
        );
        continue;
      }
      for (const row of lensRows) {
        const current = readerIdOfStamp(row.metadata);
        out.set(
          row.id,
          lookup(urlOf(row)!).some((o) => o.readerId !== current)
        );
      }
    }
    return out;
  };
}

/** `library.readWith` — one job per item with the chosen reader (the tap is the consent). */
export async function libraryReadWith(args: {
  database?: LibraryDb;
  userId: string;
  itemIds?: readonly string[];
  groupId?: string;
  /** Every waiting item of the person's Library (no group). */
  waiting?: boolean;
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
  } else if (args.groupId || args.waiting) {
    rows = await waitingRows(database, args.userId, args.groupId);
  } else {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Name items, a group, or the waiting items.",
    });
  }
  // readWith is person-only (the tRPC door refuses an agent first).
  const offersOf = await offersByRow(rows, args.userId, undefined, deps);

  const now = deps.now().getTime();
  let room: number | null = null; // computed on the first billed item
  const due: Array<{
    userId: string;
    itemId: string;
    reader: string;
    force: true;
  }> = [];
  let overBudget = 0;
  const held: string[] = [];
  for (const row of rows) {
    const url = urlOf(row);
    if (!url) {
      skipped++;
      continue;
    }
    const offer = (offersOf.get(row.id) ?? []).find(
      (o) => o.readerId === args.readerId
    );
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
        held.push(row.id);
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
  if (held.length > 0) {
    await holdOverBudget(database, args.userId, held, args.readerId);
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

/**
 * Items the tap could not afford today WAIT with the person's choice: marked
 * `over_budget` with the reader they chose (`requestedReader`), so the mark
 * says it at once and the hourly sweep reads them with THAT reader once the
 * budget has room — "It waits for tomorrow's reading budget" is then true. An
 * item already `read` keeps its read untouched (never masked by a wait).
 * Everything else on the stored read (why it was blocked, who read it, its
 * chips) is kept.
 */
async function holdOverBudget(
  database: LibraryDb,
  userId: string,
  ids: readonly string[],
  readerId: string
): Promise<void> {
  const patch = JSON.stringify({
    status: "over_budget",
    requestedReader: readerId,
  });
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${documents.metadata}, '{}'::jsonb), '{importRead}', COALESCE(${documents.metadata} -> 'importRead', '{"suggestedActions":[]}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(
      and(
        libraryItemsWhere(userId),
        inArray(documents.id, [...ids]),
        drizzleSql`COALESCE(${documents.metadata} #>> '{importRead,status}', 'not_read') <> 'read'`
      )
    );
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
    async readerLookup(ctx) {
      const { urlReaderLookup } =
        await import("../capabilities/url-readers.js");
      return urlReaderLookup(ctx);
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
