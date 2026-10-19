/**
 * Library GROUPS — the person's persistent groups (`library_groups`, 0328).
 *
 * A group outlives any import run: its note, outputs, the collection entity
 * Build minted (`containerEntityId`: a rebuild updates it, never twins it) and
 * its built state. Membership lives on the item
 * (`documents.metadata.importCuration.groupIds`); counts are read from there.
 *
 * LAZY ADOPTION of per-import groups: a group made inside an import session
 * (`focus_sessions.metadata.importCuration.groups`, keyed per import) becomes a
 * Library group the first time the Library is read (`adoptImportGroups`). It is
 * stamped `libraryGroupId` on the session's group and its members gain the id
 * — once, idempotently. No data migration rewrites rows blindly.
 *
 * Every read and write is OWNER-FLOORED (`user_id = userId`); a foreign or
 * missing id reads NOT_FOUND.
 */

import { isAdoptionClean, markAdoptionClean } from "./adoption-memo.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  db as defaultDb,
  documents,
  focusSessions,
  libraryGroups,
  proposals,
  and,
  eq,
  inArray,
  isNull,
  desc,
  drizzleSql,
  type SQL,
  type LibraryGroupRow,
} from "@synap/database";
import {
  IMPORT_GROUP_OUTPUTS,
  importGroupKey,
  readImportCuration,
  type ImportGroup,
  type ImportGroupOutput,
  type LibraryGroupView,
} from "@synap-core/types/imports";
import {
  isArchivedSql,
  libraryItemsWhere,
  runIdSql,
  libraryLensWhere,
  readStatusSql,
  waitingGroupIdsSql,
  LIBRARY_BUILT_WITHOUT_PROPOSAL,
  ungroupedSql,
  type LibraryDb,
} from "./read-model.js";

const logger = createLogger({ module: "library/groups" });

export function readOutputs(v: unknown): ImportGroupOutput[] {
  return Array.isArray(v)
    ? v.filter((o): o is ImportGroupOutput =>
        (IMPORT_GROUP_OUTPUTS as readonly string[]).includes(o as string)
      )
    : [];
}

export interface LibraryGroupCounts {
  items: number;
  read: number;
  notRead: number;
  needsFile: number;
  newSinceBuilt: number;
  actions: number;
}

const ZERO: LibraryGroupCounts = {
  items: 0,
  read: 0,
  notRead: 0,
  needsFile: 0,
  newSinceBuilt: 0,
  actions: 0,
};

export function toGroupView(
  row: LibraryGroupRow,
  counts: LibraryGroupCounts = ZERO,
  pendingBuildProposalId?: string
): LibraryGroupView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    ...(row.note ? { note: row.note } : {}),
    origin: row.origin,
    outputs: readOutputs(row.outputs),
    ...(row.containerEntityId
      ? { containerEntityId: row.containerEntityId }
      : {}),
    ...(row.builtAt ? { builtAt: row.builtAt.toISOString() } : {}),
    ...(row.buildingAt ? { buildingAt: row.buildingAt.toISOString() } : {}),
    ...(pendingBuildProposalId ? { pendingBuildProposalId } : {}),
    counts,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The `ImportGroup` shape Build reads, from a Library group. */
export function asImportGroup(row: LibraryGroupRow): ImportGroup {
  return {
    key: row.key,
    name: row.name,
    ...(row.note ? { note: row.note } : {}),
    origin: row.origin,
    outputs: readOutputs(row.outputs),
    ...(row.builtAt ? { builtAt: row.builtAt.toISOString() } : {}),
  };
}

/** One owned group, or NOT_FOUND. */
export async function loadLibraryGroup(args: {
  database?: LibraryDb;
  userId: string;
  groupId: string;
  forUpdate?: boolean;
}): Promise<LibraryGroupRow> {
  const database = args.database ?? defaultDb;
  const query = database
    .select()
    .from(libraryGroups)
    .where(
      and(
        eq(libraryGroups.id, args.groupId),
        eq(libraryGroups.userId, args.userId)
      )
    )
    .limit(1);
  const [row] = args.forUpdate ? await query.for("update") : await query;
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
  }
  return row;
}

/** The person's groups (live by default), most recently touched first. */
export async function listLibraryGroupRows(args: {
  database?: LibraryDb;
  userId: string;
  archived?: boolean;
  ids?: readonly string[];
}): Promise<LibraryGroupRow[]> {
  const database = args.database ?? defaultDb;
  return database
    .select()
    .from(libraryGroups)
    .where(
      and(
        eq(libraryGroups.userId, args.userId),
        args.archived === undefined
          ? undefined
          : args.archived
            ? drizzleSql`${libraryGroups.archivedAt} IS NOT NULL`
            : isNull(libraryGroups.archivedAt),
        args.ids ? inArray(libraryGroups.id, [...args.ids]) : undefined
      )
    )
    .orderBy(desc(libraryGroups.updatedAt), desc(libraryGroups.id));
}

/**
 * Counts per group, over unarchived items, in ONE aggregate.
 * `newSinceBuilt`: kept items staged after the group's `builtAt` (every kept
 * item when never built) — what a rebuild would read.
 */
export async function countGroups(args: {
  database?: LibraryDb;
  userId: string;
  groups: readonly LibraryGroupRow[];
  /** Count only the items inside this lens. */
  lens?: SQL;
}): Promise<Map<string, LibraryGroupCounts>> {
  const database = args.database ?? defaultDb;
  const out = new Map<string, LibraryGroupCounts>();
  if (args.groups.length === 0) return out;
  const ids = args.groups.map((g) => g.id);
  const rows = await database
    .select({
      groupIds: drizzleSql<unknown>`${documents.metadata} -> 'importCuration' -> 'groupIds'`,
      status: drizzleSql<string>`${readStatusSql}`,
      waitingIn: waitingGroupIdsSql,
      actions: drizzleSql<unknown>`${documents.metadata} -> 'importRead' -> 'suggestedActions'`,
    })
    .from(documents)
    .where(
      and(
        libraryItemsWhere(args.userId),
        args.lens,
        drizzleSql`NOT ${isArchivedSql}`,
        drizzleSql`COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb) ?| ${`{${ids.join(",")}}`}::text[]`
      )
    );
  const wanted = new Set(ids);
  for (const r of rows.flatMap((row) =>
    (Array.isArray(row.groupIds) ? (row.groupIds as unknown[]) : [])
      .filter((g): g is string => typeof g === "string" && wanted.has(g))
      .map((groupId) => ({ ...row, groupId }))
  )) {
    const c = out.get(r.groupId) ?? { ...ZERO };
    c.items += 1;
    c.actions += Array.isArray(r.actions)
      ? (r.actions as Array<{ proposalId?: unknown } | null>).filter(
          (a) => a && typeof a === "object" && !a.proposalId
        ).length
      : 0;
    if (r.status === "read") c.read += 1;
    else if (r.status === "not_read" || r.status === "over_budget")
      c.notRead += 1;
    else if (r.status === "needs_file") c.needsFile += 1;
    // The ONE "waiting" rule (`waitingInGroupSql`): kept, and not read by a
    // Build of THIS group that still counts.
    if (Array.isArray(r.waitingIn) && r.waitingIn.includes(r.groupId)) {
      c.newSinceBuilt += 1;
    }
    out.set(r.groupId, c);
  }
  return out;
}

/**
 * Per group, the NEWEST of its bundles when that one still waits for review —
 * what "Open the review" opens, and why a rebuild is refused. One query.
 */
export async function pendingBuildProposalIds(
  database: LibraryDb,
  groups: ReadonlyArray<{ groupId: string; proposalIds: readonly string[] }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const all = [
    ...new Set(groups.flatMap((g) => g.proposalIds.filter(Boolean))),
  ];
  if (all.length === 0) return out;
  const rows = await database
    .select({
      id: proposals.id,
      status: proposals.status,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(inArray(proposals.id, all));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const g of groups) {
    const newest = g.proposalIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (newest?.status === "pending") out.set(g.groupId, newest.id);
  }
  return out;
}

export function proposalIdsOf(row: LibraryGroupRow): string[] {
  return Array.isArray(row.buildProposalIds)
    ? row.buildProposalIds.filter((id): id is string => typeof id === "string")
    : [];
}

/** Rows → views: counts (optionally lensed) and the waiting bundle, in two queries. */
export async function groupViews(args: {
  database?: LibraryDb;
  userId: string;
  rows: readonly LibraryGroupRow[];
  lens?: SQL;
}): Promise<{
  views: LibraryGroupView[];
  counts: Map<string, LibraryGroupCounts>;
}> {
  const database = args.database ?? defaultDb;
  const [counts, pending] = await Promise.all([
    countGroups({
      database,
      userId: args.userId,
      groups: args.rows,
      ...(args.lens ? { lens: args.lens } : {}),
    }),
    pendingBuildProposalIds(
      database,
      args.rows.map((r) => ({ groupId: r.id, proposalIds: proposalIdsOf(r) }))
    ),
  ]);
  return {
    views: args.rows.map((r) =>
      toGroupView(r, counts.get(r.id), pending.get(r.id))
    ),
    counts,
  };
}

/** Unarchived items in no group, and archived items. */
export async function countLooseItems(args: {
  database?: LibraryDb;
  userId: string;
  lens?: SQL;
}): Promise<{ ungrouped: number; archived: number }> {
  const database = args.database ?? defaultDb;
  const [row] = await database
    .select({
      ungrouped: drizzleSql<number>`count(*) FILTER (WHERE NOT ${isArchivedSql} AND ${ungroupedSql})::int`,
      archived: drizzleSql<number>`count(*) FILTER (WHERE ${isArchivedSql})::int`,
    })
    .from(documents)
    .where(and(libraryItemsWhere(args.userId), args.lens));
  return {
    ungrouped: Number(row?.ungrouped ?? 0),
    archived: Number(row?.archived ?? 0),
  };
}

/** Insert a group with a fresh key (unique per person). */
export async function insertLibraryGroup(args: {
  database: LibraryDb;
  userId: string;
  name: string;
  note?: string | null;
  origin: "ai" | "user" | "rule";
  outputs?: ImportGroupOutput[];
  workspaceId?: string | null;
  builtAt?: Date | null;
  buildProposalIds?: string[];
  /**
   * The row's id, when the caller keys the create (an approved organise
   * proposal: one id per op, so a retried apply finds its group instead of
   * creating a second). Absent = a fresh random id.
   */
  id?: string;
}): Promise<LibraryGroupRow> {
  // The key is unique per person. Computed from what is taken, then
  // inserted with ON CONFLICT DO NOTHING: a concurrent create of the same name
  // (two devices, a list racing a curate) takes the next suffix instead of
  // failing the request — and never aborts the caller's transaction.
  for (let attempt = 0; attempt < 8; attempt++) {
    const taken = await args.database
      .select({ key: libraryGroups.key })
      .from(libraryGroups)
      .where(eq(libraryGroups.userId, args.userId));
    const key = importGroupKey(
      args.name,
      taken.map((t) => t.key)
    );
    const [row] = await args.database
      .insert(libraryGroups)
      .values({
        ...(args.id ? { id: args.id } : {}),
        userId: args.userId,
        key,
        name: args.name,
        note: args.note?.trim() ? args.note.trim() : null,
        origin: args.origin,
        outputs: args.outputs ?? ["things"],
        workspaceId: args.workspaceId ?? null,
        builtAt: args.builtAt ?? null,
        buildProposalIds: args.buildProposalIds ?? [],
      })
      .onConflictDoNothing({
        target: [libraryGroups.userId, libraryGroups.key],
      })
      .returning();
    if (row) return row;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "This group name is being used right now. Try again.",
  });
}

/** Add / remove group ids on items (owner-floored, one statement per item set). */
export async function setItemGroupIds(args: {
  database: LibraryDb;
  userId: string;
  itemIds: readonly string[];
  add: string;
}): Promise<void> {
  if (args.itemIds.length === 0) return;
  await args.database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(
        ${documents.metadata},
        '{importCuration,groupIds}',
        (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(
          COALESCE(${documents.metadata} -> 'importCuration' -> 'groupIds', '[]'::jsonb)
          || ${JSON.stringify([args.add])}::jsonb) AS x),
        true)`,
    })
    .where(
      and(
        libraryItemsWhere(args.userId),
        inArray(documents.id, [...args.itemIds]),
        drizzleSql`${documents.metadata} ? 'importCuration'`
      )
    );
}

/**
 * Turn every per-import group not yet adopted into a Library group, once.
 * Returns how many were adopted. A session whose adoption fails is logged and
 * retried on the next read (the person is not marked clean); it never fails
 * the Library read itself — the items are all there, that import's groups
 * just join later.
 */
export async function adoptImportGroups(args: {
  database?: LibraryDb;
  userId: string;
}): Promise<number> {
  const database = args.database ?? defaultDb;
  if (isAdoptionClean(args.userId)) return 0;
  const sessions = await database
    .select({
      id: focusSessions.id,
      workspaceId: focusSessions.workspaceId,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, args.userId),
        drizzleSql`jsonb_array_length(COALESCE(${focusSessions.metadata} -> 'importCuration' -> 'groups', '[]'::jsonb)) > 0`,
        // Only sessions with at least one group not yet adopted.
        drizzleSql`EXISTS (SELECT 1 FROM jsonb_array_elements(${focusSessions.metadata} -> 'importCuration' -> 'groups') AS grp WHERE NOT (grp ? 'libraryGroupId'))`
      )
    );
  let adopted = 0;
  let failed = false;
  for (const s of sessions) {
    try {
      adopted += await database.transaction(async (tx) => {
        const t = tx as unknown as LibraryDb;
        const [locked] = await t
          .select({ metadata: focusSessions.metadata })
          .from(focusSessions)
          .where(
            and(
              eq(focusSessions.id, s.id),
              eq(focusSessions.userId, args.userId)
            )
          )
          .for("update");
        const curation = readImportCuration(locked?.metadata);
        if (!curation) return 0;
        let n = 0;
        const groups: Array<ImportGroup & { libraryGroupId?: string }> = [];
        for (const g of curation.groups as Array<
          ImportGroup & { libraryGroupId?: string }
        >) {
          if (g.libraryGroupId) {
            groups.push(g);
            continue;
          }
          const row = await insertLibraryGroup({
            database: t,
            userId: args.userId,
            name: g.name,
            note: g.note ?? null,
            origin: g.origin,
            outputs: g.outputs,
            workspaceId: s.workspaceId,
            builtAt: g.builtAt ? new Date(g.builtAt) : null,
            buildProposalIds: g.buildProposalId ? [g.buildProposalId] : [],
          });
          const members = await t
            .select({ id: documents.id })
            .from(documents)
            .where(
              and(
                libraryItemsWhere(args.userId),
                drizzleSql`${runIdSql} = ${s.id}`,
                drizzleSql`COALESCE(${documents.metadata} -> 'importCuration' -> 'groupKeys', '[]'::jsonb) ? ${g.key}`
              )
            );
          await setItemGroupIds({
            database: t,
            userId: args.userId,
            itemIds: members.map((m) => m.id),
            add: row.id,
          });
          if (g.builtAt) {
            // Items that group's Build already read (their staged marker was
            // cleared) are built FOR the adopted group — by the same bundle —
            // so the Library never rebuilds them into twins.
            await t
              .update(documents)
              .set({
                metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importCuration,builtBy}', COALESCE(${documents.metadata} -> 'importCuration' -> 'builtBy', '{}'::jsonb) || ${JSON.stringify({ [row.id]: g.buildProposalId ?? LIBRARY_BUILT_WITHOUT_PROPOSAL })}::jsonb, true)`,
              })
              .where(
                and(
                  libraryItemsWhere(args.userId),
                  inArray(
                    documents.id,
                    members.map((m) => m.id)
                  ),
                  drizzleSql`(${documents.metadata} #>> '{intakeSource,pending}') IS NULL`
                )
              );
          }
          groups.push({ ...g, libraryGroupId: row.id });
          n += 1;
        }
        await t
          .update(focusSessions)
          .set({
            metadata: drizzleSql`jsonb_set(${focusSessions.metadata}, '{importCuration,groups}', ${JSON.stringify(groups)}::jsonb, true)`,
          })
          .where(
            and(
              eq(focusSessions.id, s.id),
              eq(focusSessions.userId, args.userId)
            )
          );
        return n;
      });
    } catch (err) {
      // Said, retried on the next read — never a failed Library read: the
      // items are all there, this import's groups just join later.
      logger.error(
        { err, sessionId: s.id },
        "library: import groups NOT adopted — retried on the next read"
      );
      failed = true;
    }
  }
  if (!failed) markAdoptionClean(args.userId);
  return adopted;
}

/**
 * `library.groups` — every live group with counts, plus the loose counts.
 * With a lens, counts cover only the items inside it and a group with no item
 * there is left out.
 */
export async function readLibraryGroups(args: {
  database?: LibraryDb;
  userId: string;
  lens?: { workspaceId?: string; projectId?: string };
}): Promise<{
  groups: LibraryGroupView[];
  ungrouped: number;
  archived: number;
}> {
  const database = args.database ?? defaultDb;
  await adoptImportGroups({ database, userId: args.userId });
  const rows = await listLibraryGroupRows({
    database,
    userId: args.userId,
    archived: false,
  });
  const lens = args.lens ? libraryLensWhere(args.userId, args.lens) : undefined;
  const shown = await groupViews({
    database,
    userId: args.userId,
    rows,
    ...(lens ? { lens } : {}),
  });
  const loose = await countLooseItems({
    database,
    userId: args.userId,
    ...(lens ? { lens } : {}),
  });
  return {
    groups: shown.views.filter(
      (v) => !lens || (shown.counts.get(v.id)?.items ?? 0) > 0
    ),
    ...loose,
  };
}
