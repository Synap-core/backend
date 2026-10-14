/**
 * Library SEARCH and HEALTH.
 *
 * `searchLibrary` — ONE search over both halves of intake: the person's
 * captures (their own words, `ownCapturesWhere`) and their Library items.
 * Matched in SQL on what staging and the light read wrote (title, card,
 * URL, read summary, notes); the body is not read here. Archived Library items
 * stay searchable (auto-archive is quiet, never a loss).
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
  drizzleSql,
} from "@synap/database";
import type {
  LibraryHealth,
  LibraryItemView,
  LibrarySearchResult,
} from "@synap-core/types/imports";
import { ownCapturesWhere } from "../captures/capture-scope.js";
import { CAPTURE_LIST_KINDS } from "../captures/capture-scope.js";
import { INTAKE_SOURCE_METADATA_KEY } from "../intake/stage-intake-source.js";
import {
  isArchivedSql,
  libraryItemsWhere,
  libraryTextMatchSql,
  readStatusSql,
  waitingInGroupSql,
  toLibraryItemView,
  selectLibraryItemRows,
  type LibraryDb,
} from "./read-model.js";
import { countGroups, listLibraryGroupRows } from "./groups.js";

export async function searchLibrary(args: {
  database?: LibraryDb;
  userId: string;
  q: string;
  limit: number;
}): Promise<LibrarySearchResult> {
  const database = args.database ?? defaultDb;
  const q = args.q.trim();
  if (!q) return { captures: [], items: [] };
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
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
      where: and(libraryItemsWhere(args.userId), libraryTextMatchSql(q))!,
      limit: args.limit,
    }),
  ]);
  return {
    captures: captures.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
    })),
    items: itemRows
      .map(toLibraryItemView)
      .filter((v): v is LibraryItemView => v !== null),
  };
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
