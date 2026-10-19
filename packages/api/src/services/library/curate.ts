/**
 * Library CURATE — the person's edits to their Library: groups (create,
 * rename, note, outputs, merge, archive / unarchive), membership, decisions,
 * item notes, AI suggestions accepted or dismissed, archive marks, "seen",
 * and delete / restore (a soft delete, undoable for `deleteUndoDays`).
 *
 * The name / note / merge / group-cap RULES are shared with the per-import
 * engine (`imports/curate-rules.ts`) so the two cannot drift.
 *
 * `applyLibraryCurateOps` is PURE: it applies the ops in order to an
 * in-memory state and returns what changed — or throws
 * {@link LibraryCurateError} naming the first bad op, so nothing is written.
 * `curateLibrary` loads that state (groups + items locked), runs it, and
 * writes every change in ONE transaction.
 */

import {
  CurateOpError,
  assertRoomForGroup,
  groupName,
  groupNote,
  itemNote,
  mergeGroupSettings,
} from "../imports/curate-rules.js";
import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  documents,
  libraryGroups,
  workspaces,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  type LibraryGroupRow,
} from "@synap/database";
import {
  LIBRARY_LIMITS,
  importGroupKey,
  type ImportGroupOutput,
  type LibraryCurateOp,
  type LibraryCurateResult,
} from "@synap-core/types/imports";
import {
  inGroupSql,
  libraryItemsWhere,
  citedByBundleSql,
  readLibraryCuration,
  type LibraryDb,
  type LibraryItemCurationMeta,
} from "./read-model.js";
import { enqueueLibrarySearch } from "./search-index.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import {
  groupViews,
  insertLibraryGroup,
  listLibraryGroupRows,
  readOutputs,
} from "./groups.js";

/** A bad Library edit (the shared {@link CurateOpError}). */
export class LibraryCurateError extends CurateOpError {
  constructor(opIndex: number, message: string) {
    super(opIndex, message);
    this.name = "LibraryCurateError";
  }
}

/** A group as curate sees it. `id` is a placeholder (`new:<n>`) until inserted. */
export interface CurateGroup {
  id: string;
  key: string;
  name: string;
  note: string | null;
  outputs: ImportGroupOutput[];
  archived: boolean;
  isNew: boolean;
  /** The space Build files the group into (`library_groups.workspace_id`). */
  workspaceId?: string | null;
}

/** An item as curate sees it: its curation, plus whether it is deleted / cited. */
export interface CurateItem extends LibraryItemCurationMeta {
  /** Soft-deleted (restorable): only `item.restore` reaches it. */
  deleted?: boolean;
  /** The raw of a bundle that still counts: it cannot be deleted. */
  cited?: boolean;
}

export interface LibraryCurateState {
  groups: Map<string, CurateGroup>;
  items: Map<string, CurateItem>;
}

export interface LibraryCurateChange {
  state: LibraryCurateState;
  changedGroupIds: Set<string>;
  changedItemIds: Set<string>;
  createdGroupIds: string[];
  /** Items this batch deleted / restored (their row's `deleted_at` changes). */
  deletedItemIds: Set<string>;
  restoredItemIds: Set<string>;
}

const uniq = (xs: readonly string[]) => [...new Set(xs)];

/** Apply ops in order. PURE — throws on the first invalid op. */
export function applyLibraryCurateOps(
  input: LibraryCurateState,
  ops: readonly LibraryCurateOp[],
  now: string = new Date().toISOString()
): LibraryCurateChange {
  const state: LibraryCurateState = {
    groups: new Map(
      [...input.groups].map(([id, g]) => [
        id,
        { ...g, outputs: [...g.outputs] },
      ])
    ),
    items: new Map(
      [...input.items].map(([id, c]) => [
        id,
        {
          ...c,
          groupIds: [...(c.groupIds ?? [])],
          suggestedGroupIds: [...(c.suggestedGroupIds ?? [])],
          dismissedGroupIds: [...(c.dismissedGroupIds ?? [])],
        },
      ])
    ),
  };
  const changedGroupIds = new Set<string>();
  const changedItemIds = new Set<string>();
  const createdGroupIds: string[] = [];
  const deletedItemIds = new Set<string>();
  const restoredItemIds = new Set<string>();

  ops.forEach((op, i) => {
    const fail = (message: string): never => {
      throw new LibraryCurateError(i, message);
    };
    const group = (id: string, allowArchived = false) => {
      const g = state.groups.get(id) ?? fail(`no group "${id}"`);
      if (g.archived && !allowArchived) fail(`group "${g.name}" is archived`);
      return g;
    };
    const anyItem = (id: string) =>
      state.items.get(id) ?? fail(`no item "${id}"`);
    // A deleted item is reachable only by `item.restore`.
    const item = (id: string) => {
      const c = anyItem(id);
      if (c.deleted) fail(`no item "${id}"`);
      return c;
    };
    const touchItem = (id: string, next: CurateItem) => {
      state.items.set(id, next);
      changedItemIds.add(id);
    };
    const touchGroup = (g: CurateGroup) => {
      state.groups.set(g.id, g);
      changedGroupIds.add(g.id);
    };
    const name = (raw: string) => groupName(raw, fail);
    const note = (raw: string) => groupNote(raw, fail) ?? null;
    // The person handled it: the auto-archive clock restarts (`seenAt`).
    const addTo = (itemId: string, groupId: string) => {
      const c = item(itemId);
      if (c.groupIds!.includes(groupId)) return;
      touchItem(itemId, {
        ...c,
        groupIds: [...c.groupIds!, groupId],
        suggestedGroupIds: c.suggestedGroupIds!.filter((g) => g !== groupId),
        seenAt: now,
      });
    };
    // An archived group is no longer something to suggest: drop it from every
    // loaded item's suggestions (curateLibrary loads the items that carry it).
    const pruneSuggestion = (groupId: string) => {
      for (const [id, c] of state.items) {
        if (!c.suggestedGroupIds!.includes(groupId)) continue;
        touchItem(id, {
          ...c,
          suggestedGroupIds: c.suggestedGroupIds!.filter((g) => g !== groupId),
        });
      }
    };
    const removeFrom = (itemId: string, groupId: string) => {
      const c = item(itemId);
      if (!c.groupIds!.includes(groupId)) return;
      touchItem(itemId, {
        ...c,
        groupIds: c.groupIds!.filter((g) => g !== groupId),
        seenAt: now,
      });
    };

    switch (op.op) {
      case "group.create": {
        assertRoomForGroup(
          [...state.groups.values()].filter((g) => !g.archived).length,
          fail
        );
        const n = name(op.name);
        const id = `new:${createdGroupIds.length}`;
        const key = importGroupKey(
          n,
          [...state.groups.values()].map((g) => g.key)
        );
        touchGroup({
          id,
          key,
          name: n,
          note: op.note !== undefined ? note(op.note) : null,
          outputs: ["things"],
          archived: false,
          isNew: true,
        });
        createdGroupIds.push(id);
        for (const itemId of uniq(op.itemIds ?? [])) addTo(itemId, id);
        break;
      }
      case "group.update": {
        const g = group(op.groupId);
        const next = { ...g };
        if (op.name !== undefined) next.name = name(op.name);
        if (op.note !== undefined) next.note = note(op.note);
        if (op.outputs !== undefined)
          next.outputs = uniq(op.outputs) as ImportGroupOutput[];
        // Writability of the space is checked by `curateLibrary` (async).
        if (op.workspaceId !== undefined) next.workspaceId = op.workspaceId;
        touchGroup(next);
        break;
      }
      case "group.archive": {
        const g = group(op.groupId, true);
        if (!g.archived) touchGroup({ ...g, archived: true });
        pruneSuggestion(g.id);
        break;
      }
      case "group.unarchive": {
        const g = group(op.groupId, true);
        if (g.archived) {
          assertRoomForGroup(
            [...state.groups.values()].filter((x) => !x.archived).length,
            fail
          );
          touchGroup({ ...g, archived: false });
        }
        break;
      }
      case "group.merge": {
        if (op.fromId === op.intoId) fail("a group cannot merge into itself");
        const from = group(op.fromId);
        const into = group(op.intoId);
        // The merged group's note still steers Build: both notes are kept.
        const merged = mergeGroupSettings(into, from);
        touchGroup({
          ...into,
          note: merged.note ?? null,
          outputs: merged.outputs,
        });
        for (const [id, c] of state.items) {
          if (!c.groupIds!.includes(from.id)) continue;
          touchItem(id, {
            ...c,
            groupIds: uniq(
              c.groupIds!.map((g) => (g === from.id ? into.id : g))
            ),
          });
        }
        touchGroup({ ...from, archived: true });
        pruneSuggestion(from.id);
        break;
      }
      case "group.items": {
        const g = group(op.groupId);
        for (const itemId of uniq(op.add ?? [])) addTo(itemId, g.id);
        for (const itemId of uniq(op.remove ?? [])) removeFrom(itemId, g.id);
        break;
      }
      case "item.decide": {
        for (const itemId of uniq(op.itemIds)) {
          const c = item(itemId);
          if (c.decision !== op.decision)
            touchItem(itemId, { ...c, decision: op.decision });
        }
        break;
      }
      case "item.note": {
        const text = itemNote(op.note, fail);
        const c = item(op.itemId);
        const { note: _old, ...rest } = c;
        touchItem(
          op.itemId,
          text ? { ...rest, note: text, seenAt: now } : { ...rest, seenAt: now }
        );
        break;
      }
      case "item.groups": {
        for (const g of uniq(op.add ?? [])) addTo(op.itemId, group(g).id);
        for (const g of uniq(op.remove ?? []))
          removeFrom(op.itemId, group(g, true).id);
        break;
      }
      case "suggestion.accept": {
        const g = group(op.groupId);
        addTo(op.itemId, g.id);
        break;
      }
      case "suggestion.dismiss": {
        const c = item(op.itemId);
        touchItem(op.itemId, {
          ...c,
          suggestedGroupIds: c.suggestedGroupIds!.filter(
            (g) => g !== op.groupId
          ),
          dismissedGroupIds: uniq([...c.dismissedGroupIds!, op.groupId]),
        });
        break;
      }
      case "item.archive":
      case "item.unarchive": {
        for (const itemId of uniq(op.itemIds)) {
          const c = item(itemId);
          if (op.op === "item.archive" && !c.archivedAt) {
            touchItem(itemId, { ...c, archivedAt: now });
          } else if (op.op === "item.unarchive" && c.archivedAt) {
            const { archivedAt: _a, ...rest } = c;
            touchItem(itemId, { ...rest, seenAt: now });
          }
        }
        break;
      }
      case "item.seen": {
        for (const itemId of uniq(op.itemIds)) {
          touchItem(itemId, { ...item(itemId), seenAt: now });
        }
        break;
      }
      case "item.delete": {
        for (const itemId of uniq(op.itemIds)) {
          const c = item(itemId);
          if (c.cited)
            fail(
              "this item is the source of something you built — undo that first"
            );
          touchItem(itemId, { ...c, deleted: true });
          deletedItemIds.add(itemId);
          restoredItemIds.delete(itemId);
        }
        break;
      }
      case "item.restore": {
        for (const itemId of uniq(op.itemIds)) {
          const c = anyItem(itemId);
          if (!c.deleted) continue;
          touchItem(itemId, { ...c, deleted: false, seenAt: now });
          restoredItemIds.add(itemId);
          deletedItemIds.delete(itemId);
        }
        break;
      }
      default: {
        const never: never = op;
        fail(`unknown edit ${(never as { op: string }).op}`);
      }
    }
  });
  return {
    state,
    changedGroupIds,
    changedItemIds,
    createdGroupIds,
    deletedItemIds,
    restoredItemIds,
  };
}

function itemIdsOf(ops: readonly LibraryCurateOp[]): string[] {
  const ids: string[] = [];
  for (const op of ops) {
    if ("itemIds" in op && op.itemIds) ids.push(...op.itemIds);
    if ("itemId" in op) ids.push(op.itemId);
    if (op.op === "group.items")
      ids.push(...(op.add ?? []), ...(op.remove ?? []));
  }
  return uniq(ids);
}

function toCurateGroup(row: LibraryGroupRow): CurateGroup {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    note: row.note,
    outputs: readOutputs(row.outputs),
    archived: row.archivedAt !== null,
    isNew: false,
    workspaceId: row.workspaceId,
  };
}

/**
 * A group's Build target must be a live space the person can WRITE (editor+).
 * The space is request-supplied here on purpose: it is the destination being
 * chosen, and the gate is the person's own membership of it. Not the
 * one-space-per-domain check — pointing a group at an existing space mints no
 * space.
 */
async function assertBuildTargets(
  database: LibraryDb,
  userId: string,
  ops: readonly LibraryCurateOp[]
): Promise<void> {
  const targets = new Set(
    ops.flatMap((op) =>
      op.op === "group.update" && op.workspaceId ? [op.workspaceId] : []
    )
  );
  for (const workspaceId of targets) {
    const [live] = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.archivedAt)))
      .limit(1);
    if (!live) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That space does not exist or is archived.",
      });
    }
    await assertWorkspaceWrite(database, userId, { workspaceId });
  }
}

/**
 * The batch's `group.create` ops keyed by `createIds` (one id per create op,
 * in order): a create whose id already names one of the person's groups was
 * applied by an earlier run of the SAME batch (the whole batch is one
 * transaction) and is dropped — a retried batch never creates a second group.
 * The kept creates insert with their ids (`fixedIds`, in placeholder order).
 */
function keyedCreates(
  ops: readonly LibraryCurateOp[],
  createIds: readonly string[] | undefined,
  existing: ReadonlySet<string>
): { ops: readonly LibraryCurateOp[]; fixedIds: string[] } {
  if (!createIds) return { ops, fixedIds: [] };
  const kept: LibraryCurateOp[] = [];
  const fixedIds: string[] = [];
  let n = 0;
  for (const op of ops) {
    if (op.op === "group.create") {
      const id = createIds[n++];
      if (!id) throw new Error("curateLibrary: createIds names every create");
      if (existing.has(id)) continue;
      fixedIds.push(id);
    }
    kept.push(op);
  }
  return { ops: kept, fixedIds };
}

/** Apply the person's edits atomically. Bad op ⇒ BAD_REQUEST, nothing written. */
export async function curateLibrary(args: {
  database?: LibraryDb;
  userId: string;
  ops: readonly LibraryCurateOp[];
  /**
   * Keys the batch's `group.create` ops (one id per create op, in order):
   * each inserts with its id, and one whose id already exists is skipped
   * ({@link keyedCreates}). An approved organise proposal passes ids derived
   * from the proposal, so a retried apply never makes a second list.
   */
  createIds?: readonly string[];
  /**
   * Runs FIRST inside the edit's transaction (the organise approval's
   * pending → approved claim): a throw writes nothing, and the claim commits
   * or rolls back WITH the edits.
   */
  inTransaction?: (tx: LibraryDb) => Promise<void>;
}): Promise<LibraryCurateResult> {
  const database = args.database ?? defaultDb;
  const written = await database.transaction(async (tx) => {
    const t = tx as unknown as LibraryDb;
    if (args.inTransaction) await args.inTransaction(t);
    // Every group of the person (keys must stay unique; ids are validated).
    const groupRows = await listLibraryGroupRows({
      database: t,
      userId: args.userId,
    });
    const groups = new Map(groupRows.map((g) => [g.id, toCurateGroup(g)]));
    const { ops, fixedIds } = keyedCreates(
      args.ops,
      args.createIds,
      new Set(groups.keys())
    );
    await assertBuildTargets(t, args.userId, ops);
    // Items: the ones named, plus every member of a group being merged.
    const ids = new Set(itemIdsOf(ops));
    for (const op of ops) {
      if (op.op !== "group.merge" || !groups.has(op.fromId)) continue;
      const members = await t
        .select({ id: documents.id })
        .from(documents)
        .where(and(libraryItemsWhere(args.userId), inGroupSql(op.fromId)));
      for (const m of members) ids.add(m.id);
    }
    // …and every item still SUGGESTING a group being archived (or merged
    // away), so the suggestion is pruned with it.
    for (const op of ops) {
      const gone =
        op.op === "group.archive"
          ? op.groupId
          : op.op === "group.merge"
            ? op.fromId
            : null;
      if (!gone || !groups.has(gone)) continue;
      const suggesting = await t
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            libraryItemsWhere(args.userId),
            drizzleSql`COALESCE(${documents.metadata} -> 'importCuration' -> 'suggestedGroupIds', '[]'::jsonb) ? ${gone}`
          )
        );
      for (const m of suggesting) ids.add(m.id);
    }
    // Live items, plus deleted ones still inside the undo window (only
    // `item.restore` can reach those), locked; with whether a bundle that
    // still counts was built from each.
    const rows = ids.size
      ? await t
          .select({
            id: documents.id,
            metadata: documents.metadata,
            deleted: drizzleSql<boolean>`${documents.deletedAt} IS NOT NULL`,
            cited: citedByBundleSql,
          })
          .from(documents)
          .where(
            and(
              eq(documents.userId, args.userId),
              drizzleSql`${documents.metadata} ? 'importItem'`,
              inArray(documents.id, [...ids]),
              drizzleSql`(${documents.deletedAt} IS NULL OR ${documents.deletedAt} > now() - make_interval(days => ${LIBRARY_LIMITS.deleteUndoDays}))`
            )
          )
          .for("update")
      : [];
    const items = new Map<string, CurateItem>(
      rows.map((r) => [
        r.id,
        {
          ...readLibraryCuration(r.metadata),
          deleted: r.deleted,
          cited: r.cited,
        },
      ])
    );

    let change: LibraryCurateChange;
    try {
      change = applyLibraryCurateOps({ groups, items }, ops);
    } catch (err) {
      if (err instanceof LibraryCurateError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
      throw err;
    }

    // Insert new groups first: their real ids replace the placeholders.
    const realId = new Map<string, string>();
    for (const [n, placeholder] of change.createdGroupIds.entries()) {
      const g = change.state.groups.get(placeholder)!;
      const row = await insertLibraryGroup({
        database: t,
        ...(fixedIds[n] ? { id: fixedIds[n] } : {}),
        userId: args.userId,
        name: g.name,
        note: g.note,
        origin: "user",
        outputs: g.outputs,
        workspaceId: g.workspaceId ?? null,
      });
      realId.set(placeholder, row.id);
    }
    const resolve = (id: string) => realId.get(id) ?? id;
    const now = new Date();
    for (const id of change.changedGroupIds) {
      if (realId.has(id)) continue;
      const g = change.state.groups.get(id)!;
      await t
        .update(libraryGroups)
        .set({
          name: g.name,
          note: g.note,
          outputs: g.outputs,
          ...(g.workspaceId !== undefined
            ? { workspaceId: g.workspaceId }
            : {}),
          archivedAt: g.archived
            ? drizzleSql`COALESCE(${libraryGroups.archivedAt}, now())`
            : null,
          updatedAt: now,
        })
        .where(
          and(eq(libraryGroups.id, id), eq(libraryGroups.userId, args.userId))
        );
    }
    for (const id of change.changedItemIds) {
      const { deleted: _d, cited: _c, ...c } = change.state.items.get(id)!;
      const next = {
        ...c,
        groupIds: uniq((c.groupIds ?? []).map(resolve)),
      };
      await t
        .update(documents)
        .set({
          // `note` / `archivedAt` are dropped first: an op that cleared them
          // must not leave the old value behind the merge.
          metadata: drizzleSql`jsonb_set(COALESCE(${documents.metadata}, '{}'::jsonb), '{importCuration}', (COALESCE(${documents.metadata} -> 'importCuration', '{}'::jsonb) - 'note' - 'archivedAt') || ${JSON.stringify(next)}::jsonb, true)`,
          updatedAt: now,
          ...(change.deletedItemIds.has(id)
            ? { deletedAt: now }
            : change.restoredItemIds.has(id)
              ? { deletedAt: null }
              : {}),
        })
        .where(
          and(
            eq(documents.userId, args.userId),
            drizzleSql`${documents.metadata} ? 'importItem'`,
            eq(documents.id, id)
          )
        );
    }
    return {
      deletedItemIds: [...change.deletedItemIds],
      restoredItemIds: [...change.restoredItemIds],
      createdGroupIds: change.createdGroupIds.map(resolve),
      changedGroupIds: [...change.changedGroupIds].map(resolve),
      changedItemIds: [...change.changedItemIds],
    };
  });
  // The touched groups as they now read (after commit, with counts).
  const touched = [
    ...new Set([...written.createdGroupIds, ...written.changedGroupIds]),
  ];
  const rows = touched.length
    ? await listLibraryGroupRows({
        database,
        userId: args.userId,
        ids: touched,
      })
    : [];
  // A deleted item leaves search now (its stored text and page are purged
  // after the undo window by the keep-alive pass); a restored one comes back.
  await enqueueLibrarySearch("delete", written.deletedItemIds);
  // A restored item comes back; a regrouped one's search row names its new
  // first group (`libraryGroupId`, the Library route of a search hit).
  await enqueueLibrarySearch("upsert", [
    ...new Set([
      ...written.restoredItemIds,
      ...written.changedItemIds.filter(
        (id) => !written.deletedItemIds.includes(id)
      ),
    ]),
  ]);
  // Opening an item is when an item kept before the Library shipped gets its
  // light read (the sweep never bulk-reads that backlog). Idempotent: a final
  // read is kept.
  const seen = args.ops.flatMap((op) =>
    op.op === "item.seen" ? op.itemIds : []
  );
  if (seen.length > 0) {
    const { enqueueLibraryLightRead } = await import("./light-read-queue.js");
    await enqueueLibraryLightRead(
      [...new Set(seen)].map((itemId) => ({ userId: args.userId, itemId }))
    );
  }
  const { views } = await groupViews({ database, userId: args.userId, rows });
  const { deletedItemIds: _del, restoredItemIds: _res, ...result } = written;
  return { ...result, groups: views };
}
