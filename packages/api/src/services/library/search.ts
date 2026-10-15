/**
 * Library SEARCH and HEALTH.
 *
 * `searchLibrary` — ONE search over both halves of intake: the person's
 * captures (their own words, `ownCapturesWhere`) and their Library items.
 * Matched in SQL on what staging and the light read wrote (title, card,
 * URL, read summary, notes). The read TEXT lives in storage, not in the row, so
 * it is matched through the search index (`read-text-search.ts`): a caller that
 * asked the index passes the ids it returned as `readTextIds`, and the SQL then
 * decides — the owner floor (`libraryItemsWhere`) applies to EVERY id, so an
 * index hit is only a candidate, never a grant. Archived Library items stay
 * searchable (auto-archive is quiet, never a loss).
 *
 * `libraryHealth` — orient's `StartHere.library`: items not read yet, groups
 * waiting (unarchived groups with kept items never built or new since built),
 * and how long the oldest such item has waited.
 */

import {
  db as defaultDb,
  documents,
  and,
  desc,
  inArray,
  or,
  drizzleSql,
  type SQL,
} from "@synap/database";
import type {
  LibraryHealth,
  LibrarySearchResult,
} from "@synap-core/types/imports";
import { ownCapturesWhere } from "../captures/capture-scope.js";
import { CAPTURE_LIST_KINDS } from "../captures/capture-scope.js";
import { INTAKE_SOURCE_METADATA_KEY } from "../intake/stage-intake-source.js";
import {
  isArchivedSql,
  libraryItemsWhere,
  libraryLensWhere,
  libraryTextMatchSql,
  readStatusSql,
  waitingInGroupSql,
  libraryItemViews,
  selectLibraryItemRows,
  type LibraryDb,
  type LibraryReaderAvailability,
} from "./read-model.js";
import { countGroups, listLibraryGroupRows } from "./groups.js";
import {
  findLibraryReadTextIds,
  LIBRARY_READ_TEXT_POOL,
  type LibraryReadTextLookup,
} from "./read-text-search.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "library/search" });

export async function searchLibrary(args: {
  database?: LibraryDb;
  userId: string;
  q: string;
  limit: number;
  /**
   * Library item ids the search index matched on the READ TEXT (see
   * `findLibraryReadTextIds`). Joined to the SQL match with OR, then floored
   * by the owner predicate like every other row.
   */
  readTextIds?: readonly string[];
  /** Narrow to a project's runs (the Library's own lens). */
  lens?: { projectId?: string };
  /** The person's doors ask for the rows' reader bit (one lookup per page). */
  readerAvailability?: LibraryReaderAvailability;
}): Promise<LibrarySearchResult> {
  const database = args.database ?? defaultDb;
  const q = args.q.trim();
  if (!q) return { captures: [], items: [] };
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const textMatch: SQL = args.readTextIds?.length
    ? or(libraryTextMatchSql(q), inArray(documents.id, [...args.readTextIds]))!
    : libraryTextMatchSql(q);
  const [captures, itemRows] = await Promise.all([
    database
      .select({
        id: documents.id,
        title: documents.title,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          ownCapturesWhere(args.userId),
          inArray(
            drizzleSql<string>`${documents.metadata} -> ${INTAKE_SOURCE_METADATA_KEY} ->> 'kind'`,
            [...CAPTURE_LIST_KINDS]
          ),
          drizzleSql`${documents.title} ILIKE ${like}`
        )
      )
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(args.limit),
    selectLibraryItemRows({
      database,
      where: and(
        libraryItemsWhere(args.userId),
        textMatch,
        args.lens ? libraryLensWhere(args.userId, args.lens) : undefined
      )!,
      limit: args.limit,
    }),
  ]);
  return {
    captures: captures.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
    })),
    items: await libraryItemViews(itemRows, args.readerAvailability),
  };
}

/**
 * `searchLibrary` PLUS the read text: asks the search index which of the
 * person's Library items match on what was read from them, then lets the SQL
 * decide (owner floor on every id). `readTextSearch: "down"` says the index
 * could not be asked — the SQL matches still stand, but items findable only by
 * their read text may be missing, so a caller must say so (never "found
 * nothing"). The lookup is injectable for tests; it defaults to the real index.
 */
export async function searchLibraryWithReadText(args: {
  database?: LibraryDb;
  userId: string;
  q: string;
  limit: number;
  lens?: { projectId?: string };
  lookup?: LibraryReadTextLookup;
  readerAvailability?: LibraryReaderAvailability;
}): Promise<LibrarySearchResult & { readTextSearch: "ok" | "down" }> {
  const q = args.q.trim();
  let readTextIds: string[] = [];
  let readTextSearch: "ok" | "down" = "ok";
  if (q) {
    try {
      readTextIds = await (args.lookup ?? findLibraryReadTextIds)({
        userId: args.userId,
        q,
        limit: Math.max(args.limit, LIBRARY_READ_TEXT_POOL),
      });
    } catch (err) {
      readTextSearch = "down";
      logger.warn(
        { err },
        "library search: the read-text index could not be asked — title/URL/summary/note matches only"
      );
    }
  }
  const result = await searchLibrary({ ...args, q, readTextIds });
  return { ...result, readTextSearch };
}

export async function libraryHealth(args: {
  database?: LibraryDb;
  userId: string;
  now?: Date;
}): Promise<LibraryHealth> {
  const database = args.database ?? defaultDb;
  const now = args.now ?? new Date();
  const [unreadRow] = await database
    .select({
      n: drizzleSql<number>`count(*) FILTER (WHERE ${readStatusSql} IN ('not_read', 'over_budget'))::int`,
    })
    .from(documents)
    .where(
      and(libraryItemsWhere(args.userId), drizzleSql`NOT ${isArchivedSql}`)
    );
  const groups = await listLibraryGroupRows({
    database,
    userId: args.userId,
    archived: false,
  });
  const counts = await countGroups({ database, userId: args.userId, groups });
  const waiting = groups.filter(
    (g) => (counts.get(g.id)?.newSinceBuilt ?? 0) > 0
  );
  // The oldest item still waiting in a live group — ONE aggregate, the same
  // waiting rule as the counts (`waitingInGroupSql`).
  let oldestWaitDays: number | null = null;
  if (waiting.length > 0) {
    const live = `{${waiting.map((g) => g.id).join(",")}}`;
    const [row] = await database
      .select({
        oldest: drizzleSql<
          number | null
        >`extract(epoch from min(${documents.createdAt}))::float8`,
      })
      .from(documents)
      .where(
        and(
          libraryItemsWhere(args.userId),
          drizzleSql`NOT ${isArchivedSql}`,
          drizzleSql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)) AS hg(id)
            WHERE hg.id = ANY(${live}::text[])
              AND ${waitingInGroupSql(drizzleSql`${documents.metadata}`, drizzleSql`hg.id`)})`
        )
      );
    if (row?.oldest !== null && row?.oldest !== undefined) {
      oldestWaitDays = Math.max(
        0,
        Math.floor((now.getTime() - Number(row.oldest) * 1000) / 86_400_000)
      );
    }
  }
  return {
    unread: Number(unreadRow?.n ?? 0),
    groupsWaiting: waiting.length,
    oldestWaitDays,
  };
}
