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
 * index `documents_library_items_idx` (0328). The cursor carries the row's
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
  readLibraryItemMedia,
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

/** The import run an item was staged in (`intakeSource.sessionId`), as text. */
export const runIdSql = drizzleSql<string>`(${documents.metadata} #>> '{intakeSource,sessionId}')`;

/** Archived, as an expression over ANY metadata column (raw queries with aliases use this). */
export function isArchivedOn(metadata: SQL): SQL {
  return drizzleSql`((${metadata} #>> '{importCuration,archivedAt}') IS NOT NULL)`;
}

export const isArchivedSql = isArchivedOn(drizzleSql`${documents.metadata}`);

/**
 * Proposal statuses under which a Build still COUNTS for its items: waiting
 * for review, or applied. A rejected, reverted, withdrawn, expired or failed
 * bundle leaves its items unbuilt again — so the next build reads them.
 */
export const LIBRARY_BUILT_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "auto_approved",
] as const;

/** `importCuration.builtBy[groupId]` when a Build applied with no proposal row. */
export const LIBRARY_BUILT_WITHOUT_PROPOSAL = "applied";

/**
 * THE "built for this group" predicate — ONE fragment shared by Build, group
 * counts (`newSinceBuilt`), health and the keep-alive job.
 *
 * An item is built for group G iff `importCuration.builtBy[G]` names a bundle
 * that still counts ({@link LIBRARY_BUILT_PROPOSAL_STATUSES}) — DERIVED from
 * the proposal's status, so a rejected or reverted bundle needs no clean-up
 * hook and can never strand its items. Per item and per group: an old item
 * joining a built group, or one added while a build ran, is unbuilt there.
 *
 * `metadata` / `groupId` are SQL expressions so a raw query with its own
 * aliases (`d.metadata`, `g.id::text`) uses the same rule.
 */
export function builtForGroupSql(metadata: SQL, groupId: SQL): SQL {
  return countingBundleSql(
    drizzleSql`(${metadata} -> 'importCuration' -> 'builtBy' ->> (${groupId}))`
  );
}

/**
 * A `builtBy` value still counts: "applied" (no proposal row), or a bundle
 * proposal that is pending / approved / auto-approved.
 */
export function countingBundleSql(by: SQL): SQL {
  return drizzleSql`(CASE
    WHEN ${by} IS NULL THEN false
    WHEN ${by} = ${LIBRARY_BUILT_WITHOUT_PROPOSAL} THEN true
    WHEN ${by} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN EXISTS (SELECT 1 FROM proposals bp
                    WHERE bp.id = (${by})::uuid
                      AND bp.status = ANY(${`{${LIBRARY_BUILT_PROPOSAL_STATUSES.join(",")}}`}::text[]))
    ELSE false END)`;
}

/**
 * The item is the raw of a bundle that still counts (any group, or Read now):
 * deleting it would pull the source out from under a filed proposal.
 */
export const citedByBundleSql = drizzleSql<boolean>`EXISTS (
  SELECT 1 FROM jsonb_each_text(COALESCE(${documents.metadata} -> 'importCuration' -> 'builtBy', '{}'::jsonb)) AS cb(gid, by)
  WHERE ${countingBundleSql(drizzleSql`cb.by`)})`;

/** A kept member of group G that no counting Build has read: what a rebuild reads. */
export function waitingInGroupSql(metadata: SQL, groupId: SQL): SQL {
  return drizzleSql`(COALESCE(${metadata} #>> '{importCuration,decision}', 'keep') = 'keep'
    AND NOT ${builtForGroupSql(metadata, groupId)})`;
}

/** The ids of this row's groups it is WAITING in, as a jsonb array (per-row subquery). */
export const waitingGroupIdsSql = drizzleSql<unknown>`(SELECT COALESCE(jsonb_agg(wg.id), '[]'::jsonb)
  FROM jsonb_array_elements_text(COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)) AS wg(id)
  WHERE ${waitingInGroupSql(drizzleSql`${documents.metadata}`, drizzleSql`wg.id`)})`;

/**
 * Kept through a Library door (`importItem.lightRead`, the rollout marker), or
 * already in the light-read pipeline (`importRead` exists — opened, Read now,
 * or read before). The sweep reads only these.
 */
export const lightReadEligibleSql = drizzleSql`((${documents.metadata} #>> '{importItem,lightRead}') = 'true' OR ${documents.metadata} ? 'importRead')`;

export function inGroupSql(groupId: string): SQL {
  return drizzleSql`COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb) ? ${groupId}`;
}

export const ungroupedSql = drizzleSql`jsonb_array_length(COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)) = 0`;

const LIBRARY_ITEM_COLUMNS = {
  id: documents.id,
  workspaceId: documents.workspaceId,
  metadata: documents.metadata,
  createdAt: documents.createdAt,
  createdAtText: drizzleSql<string>`${documents.createdAt}::text`,
  storageKey: documents.storageKey,
  mimeType: documents.mimeType,
};

export interface LibraryItemRow {
  id: string;
  workspaceId: string | null;
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
  const media = readLibraryItemMedia(row.metadata);
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
    ...(media.media.length ? { media: media.media } : {}),
    ...(media.failed ? { mediaFailed: media.failed } : {}),
    ...(media.failedAt ? { mediaFailedAt: media.failedAt } : {}),
  };
}

/**
 * Which of a page's rows a reader can serve (`LibraryItemView.readerAvailable`),
 * answered for the whole page at once (`libraryReaderAvailability`, readers.ts).
 * A row absent from the map is not a weak read, or not known.
 */
export type LibraryReaderAvailability = (
  rows: ReadonlyArray<{
    id: string;
    workspaceId: string | null;
    metadata: unknown;
  }>
) => Promise<ReadonlyMap<string, boolean>>;

/** Rows → views, with the page's reader bit when the door asks for it. */
export async function libraryItemViews(
  rows: readonly LibraryItemRow[],
  readerAvailability?: LibraryReaderAvailability
): Promise<LibraryItemView[]> {
  const views = rows
    .map(toLibraryItemView)
    .filter((v): v is LibraryItemView => v !== null);
  if (!readerAvailability || views.length === 0) return views;
  const known = await readerAvailability(rows);
  return views.map((v) =>
    known.has(v.id) ? { ...v, readerAvailable: known.get(v.id)! } : v
  );
}

function encodeCursor(row: { createdAtText: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAtText, i: row.id })
  ).toString("base64url");
}

const CURSOR_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres `timestamptz::text`: `2026-10-13 10:00:00.123007+00`. */
const CURSOR_TS =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** True when the cursor's timestamp is a real instant (not just shaped like one). */
function cursorInstantOk(text: string): boolean {
  const m = CURSOR_TS.exec(text);
  if (!m) return false;
  // A real calendar day (JS rolls 2026-02-30 over to March; Postgres refuses it).
  const [y, mo, d] = m[1]!.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false;
  const zone =
    m[3] === "Z"
      ? "Z"
      : m[3]!.length === 3
        ? `${m[3]}:00`
        : m[3]!.includes(":")
          ? m[3]!
          : `${m[3]!.slice(0, 3)}:${m[3]!.slice(3)}`;
  // Millisecond precision is enough to validate; the TEXT (with its
  // microseconds) is what pages.
  const ms = m[2]!.replace(/(\.\d{3})\d+$/, "$1");
  return !Number.isNaN(Date.parse(`${m[1]}T${ms}${zone}`));
}

/** A forged or odd cursor is BAD_REQUEST — never a cast error from Postgres. */
export function decodeCursor(cursor: string): {
  createdAt: string;
  id: string;
} {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      !CURSOR_UUID.test(parsed.i) ||
      !cursorInstantOk(parsed.c)
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
    parts.push(drizzleSql`${runIdSql} IN (
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
  /** The person's doors ask for the rows' reader bit (one lookup per page). */
  readerAvailability?: LibraryReaderAvailability;
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
  const items = await libraryItemViews(page, args.readerAvailability);
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
