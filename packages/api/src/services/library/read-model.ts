/**
 * The Library READ MODEL — every staged item the person kept, across import
 * runs (CAPTURE_LIBRARY_PLAN decision 3: the Library is a LENS, not a store).
 *
 * A Library item is a document with `metadata.importItem` (staged by the
 * import door). Its membership, decision, note and archive mark live on
 * `metadata.importCuration` ({@link LibraryItemCurationMeta}); the light read
 * (written by the `library-light-read` worker) on `metadata.importRead`.
 *
 * Paging is a SQL keyset on (created_at DESC, id DESC), served by the partial
 * index `documents_library_items_idx` (0326). The cursor carries the row's
 * created_at as Postgres TEXT (microseconds), never a JS Date — a Date drops
 * the microseconds and would page rows staged in one millisecond out of order.
 *
 * Owner-floored: `user_id = caller`. A failed read throws; an empty Library
 * reads `items: []`.
 */

import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  documents,
  focusSessions,
  and,
  eq,
  or,
  desc,
  inArray,
  drizzleSql,
  type SQL,
} from "@synap/database";
import {
  LIBRARY_LIMITS,
  readLibraryItemRead,
  type LibraryItemView,
  type LibraryListRequest,
  type LibraryReadStatus,
} from "@synap-core/types/imports";
import { readItemCuration, toItemView } from "../imports/read-model.js";

export type LibraryDb = typeof defaultDb;

/** `documents.metadata.importCuration` as the Library writes it (a superset of `ImportItemCuration`). */
export interface LibraryItemCurationMeta {
  decision?: "keep" | "later" | "exclude";
  note?: string;
  /** Legacy per-import group keys (open imports still read them). */
  groupKeys?: string[];
  /** Library group ids (`library_groups.id`). */
  groupIds?: string[];
  suggestedGroupIds?: string[];
  /** Suggestions the person dismissed: never suggested again. */
  dismissedGroupIds?: string[];
  archivedAt?: string;
  /** Last time a Build read the item. */
  builtAt?: string;
  /** The capture holding the note typed at share time. */
  captureNoteId?: string;
  /** Last time the person opened / touched it (auto-archive clock). */
  seenAt?: string;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function readLibraryCuration(
  metadata: unknown
): LibraryItemCurationMeta {
  const raw = (metadata as Record<string, unknown> | null)?.importCuration;
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const base = readItemCuration(metadata);
  return {
    decision: base.decision,
    ...(base.note ? { note: base.note } : {}),
    groupKeys: base.groupKeys,
    groupIds: strings(c.groupIds),
    suggestedGroupIds: strings(c.suggestedGroupIds),
    dismissedGroupIds: strings(c.dismissedGroupIds),
    ...(typeof c.archivedAt === "string" ? { archivedAt: c.archivedAt } : {}),
    ...(typeof c.builtAt === "string" ? { builtAt: c.builtAt } : {}),
    ...(typeof c.captureNoteId === "string"
      ? { captureNoteId: c.captureNoteId }
      : {}),
    ...(typeof c.seenAt === "string" ? { seenAt: c.seenAt } : {}),
  };
}

/**
 * Every live Library item of one person. The `? 'importItem'` and
 * `deleted_at IS NULL` are written as LITERALS (not bound parameters) so the
 * planner can match the partial index's predicate.
 */
export function libraryItemsWhere(userId: string): SQL {
  return and(
    eq(documents.userId, userId),
    drizzleSql`${documents.deletedAt} IS NULL`,
    drizzleSql`${documents.metadata} ? 'importItem'`
  )!;
}

/** The effective read status in SQL — the same fallback as `readLibraryItemRead`. */
export const readStatusSql = drizzleSql<string>`COALESCE(
  ${documents.metadata} #>> '{importRead,status}',
  CASE ${documents.metadata} #>> '{importItem,contentStatus}'
    WHEN 'needs_file' THEN 'needs_file'
    WHEN 'title_only' THEN 'title_only'
    ELSE 'not_read' END)`;

export const isArchivedSql = drizzleSql`(${documents.metadata} #>> '{importCuration,archivedAt}') IS NOT NULL`;

export function inGroupSql(groupId: string): SQL {
  return drizzleSql`COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb) ? ${groupId}`;
}

export const ungroupedSql = drizzleSql`jsonb_array_length(COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)) = 0`;

const LIBRARY_ITEM_COLUMNS = {
  id: documents.id,
  metadata: documents.metadata,
  createdAt: documents.createdAt,
  createdAtText: drizzleSql<string>`${documents.createdAt}::text`,
  storageKey: documents.storageKey,
  mimeType: documents.mimeType,
};

export interface LibraryItemRow {
  id: string;
  metadata: unknown;
  createdAt: Date;
  createdAtText: string;
  storageKey: string | null;
  mimeType: string | null;
}

/** Library item rows, newest-first or oldest-first, under `where` (owner floor included by the caller). */
export async function selectLibraryItemRows(args: {
  database: LibraryDb;
  where: SQL;
  order?: "newest" | "oldest";
  limit?: number;
}): Promise<LibraryItemRow[]> {
  const order =
    args.order === "oldest"
      ? [documents.createdAt, documents.id]
      : [desc(documents.createdAt), desc(documents.id)];
  const query = args.database
    .select(LIBRARY_ITEM_COLUMNS)
    .from(documents)
    .where(args.where)
    .orderBy(...order);
  return (await (args.limit !== undefined
    ? query.limit(args.limit)
    : query)) as LibraryItemRow[];
}

/** One row → the view every client reads. Null when the row is not a Library item. */
export function toLibraryItemView(row: {
  id: string;
  metadata: unknown;
  createdAt: Date;
}): LibraryItemView | null {
  const base = toItemView(row);
  if (!base) return null;
  const c = readLibraryCuration(row.metadata);
  const source = (row.metadata as Record<string, unknown> | null)
    ?.intakeSource as { sessionId?: string | null } | undefined;
  const groupIds = c.groupIds ?? [];
  return {
    ...base,
    read: readLibraryItemRead(row.metadata, base.contentStatus),
    groupIds,
    suggestedGroupIds: (c.suggestedGroupIds ?? []).filter(
      (g) => !groupIds.includes(g) && !(c.dismissedGroupIds ?? []).includes(g)
    ),
    runId: source?.sessionId ?? "",
    ...(c.archivedAt ? { archivedAt: c.archivedAt } : {}),
    ...(c.builtAt ? { builtAt: c.builtAt } : {}),
    ...(c.captureNoteId ? { captureNoteId: c.captureNoteId } : {}),
  };
}

function encodeCursor(row: { createdAtText: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAtText, i: row.id })
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[ T][\d:.]+([+-]\d{2}(:?\d{2})?|Z)?$/.test(parsed.c)
    ) {
      throw new Error("malformed");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
}

/** A search term against what staging and the light read wrote — never the body. */
export function libraryTextMatchSql(q: string): SQL {
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return drizzleSql`(
    ${documents.title} ILIKE ${like}
    OR (${documents.metadata} #>> '{importItem,title}') ILIKE ${like}
    OR (${documents.metadata} #>> '{importItem,card,description}') ILIKE ${like}
    OR (${documents.metadata} #>> '{importItem,source,url}') ILIKE ${like}
    OR (${documents.metadata} #>> '{importRead,summary}') ILIKE ${like}
    OR (${documents.metadata} #>> '{importCuration,note}') ILIKE ${like})`;
}

/** The lens (a space and/or a project), as SQL; undefined when none. */
export function libraryLensWhere(
  userId: string,
  lens: { workspaceId?: string; projectId?: string }
): SQL | undefined {
  const parts: SQL[] = [];
  if (lens.workspaceId) parts.push(eq(documents.workspaceId, lens.workspaceId));
  if (lens.projectId) {
    // A run carries the project; its items carry the run.
    parts.push(drizzleSql`(${documents.metadata} #>> '{intakeSource,sessionId}') IN (
      SELECT ${focusSessions.id}::text FROM ${focusSessions}
       WHERE ${focusSessions.userId} = ${userId}
         AND ${focusSessions.projectId} = ${lens.projectId})`);
  }
  return parts.length ? and(...parts) : undefined;
}

/** The filters of `library.list`, as SQL. */
export function libraryFilterWhere(
  userId: string,
  input: Omit<LibraryListRequest, "cursor" | "limit">
): SQL {
  const parts: SQL[] = [libraryItemsWhere(userId)];
  parts.push(input.archived ? isArchivedSql : drizzleSql`NOT ${isArchivedSql}`);
  if (input.groupId === "ungrouped") parts.push(ungroupedSql);
  else if (input.groupId) parts.push(inGroupSql(input.groupId));
  if (input.status) {
    parts.push(drizzleSql`${readStatusSql} = ${input.status}`);
  }
  const lens = libraryLensWhere(userId, input);
  if (lens) parts.push(lens);
  const q = input.q?.trim();
  if (q) parts.push(libraryTextMatchSql(q));
  return and(...parts)!;
}

/** `library.list` — newest first, keyset-paged. */
export async function listLibraryItems(args: {
  database?: LibraryDb;
  userId: string;
  input: LibraryListRequest;
}): Promise<{ items: LibraryItemView[]; nextCursor?: string }> {
  const database = args.database ?? defaultDb;
  const limit = Math.min(
    Math.max(args.input.limit ?? LIBRARY_LIMITS.pageDefault, 1),
    LIBRARY_LIMITS.pageMax
  );
  const after = args.input.cursor ? decodeCursor(args.input.cursor) : null;
  const rows = (await database
    .select(LIBRARY_ITEM_COLUMNS)
    .from(documents)
    .where(
      and(
        libraryFilterWhere(args.userId, args.input),
        after
          ? or(
              drizzleSql`${documents.createdAt} < ${after.createdAt}::timestamptz`,
              and(
                drizzleSql`${documents.createdAt} = ${after.createdAt}::timestamptz`,
                drizzleSql`${documents.id} < ${after.id}::uuid`
              )
            )
          : undefined
      )
    )
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(limit + 1)) as LibraryItemRow[];
  const page = rows.slice(0, limit);
  const items = page
    .map(toLibraryItemView)
    .filter((v): v is LibraryItemView => v !== null);
  return {
    items,
    ...(rows.length > limit
      ? { nextCursor: encodeCursor(page[page.length - 1]!) }
      : {}),
  };
}

/** Owner-floored Library item rows by id (for writes). */
export async function loadLibraryItemRows(args: {
  database: LibraryDb;
  userId: string;
  ids: readonly string[];
  forUpdate?: boolean;
}): Promise<LibraryItemRow[]> {
  if (args.ids.length === 0) return [];
  const query = args.database
    .select(LIBRARY_ITEM_COLUMNS)
    .from(documents)
    .where(
      and(libraryItemsWhere(args.userId), inArray(documents.id, [...args.ids]))
    );
  return (
    args.forUpdate ? await query.for("update") : await query
  ) as LibraryItemRow[];
}

export type { LibraryReadStatus };
