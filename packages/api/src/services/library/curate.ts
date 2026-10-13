/**
 * Library CURATE — the person's edits to their Library: groups (create,
 * rename, note, outputs, merge, archive), membership, decisions, item notes,
 * AI suggestions accepted or dismissed, archive marks.
 *
 * `applyLibraryCurateOps` is PURE: it applies the ops in order to an
 * in-memory state and returns what changed — or throws
 * {@link LibraryCurateError} naming the first bad op, so nothing is written.
 * `curateLibrary` loads that state (groups + items locked), runs it, and
 * writes every change in ONE transaction.
 */

import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  documents,
  libraryGroups,
  and,
  eq,
  drizzleSql,
  type LibraryGroupRow,
} from "@synap/database";
import {
  IMPORT_LIMITS,
  importGroupKey,
  type ImportGroupOutput,
  type LibraryCurateOp,
  type LibraryCurateResult,
} from "@synap-core/types/imports";
import {
  inGroupSql,
  libraryItemsWhere,
  loadLibraryItemRows,
  readLibraryCuration,
  type LibraryDb,
  type LibraryItemCurationMeta,
} from "./read-model.js";
import {
  countGroups,
  listLibraryGroupRows,
  readOutputs,
  toGroupView,
} from "./groups.js";

export class LibraryCurateError extends Error {
  constructor(
    readonly opIndex: number,
    message: string
  ) {
    super(`Edit #${opIndex + 1}: ${message}`);
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
}

export interface LibraryCurateState {
  groups: Map<string, CurateGroup>;
  items: Map<string, LibraryItemCurationMeta>;
}

export interface LibraryCurateChange {
  state: LibraryCurateState;
  changedGroupIds: Set<string>;
  changedItemIds: Set<string>;
  createdGroupIds: string[];
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
  const L = IMPORT_LIMITS;

  ops.forEach((op, i) => {
    const fail = (message: string): never => {
      throw new LibraryCurateError(i, message);
    };
    const group = (id: string, allowArchived = false) => {
      const g = state.groups.get(id) ?? fail(`no group "${id}"`);
      if (g.archived && !allowArchived) fail(`group "${g.name}" is archived`);
      return g;
    };
    const item = (id: string) => state.items.get(id) ?? fail(`no item "${id}"`);
    const touchItem = (id: string, next: LibraryItemCurationMeta) => {
      state.items.set(id, next);
      changedItemIds.add(id);
    };
    const touchGroup = (g: CurateGroup) => {
      state.groups.set(g.id, g);
      changedGroupIds.add(g.id);
    };
    const name = (raw: string) => {
      const n = raw.replace(/\s+/g, " ").trim();
      if (!n) fail("a group needs a name");
      if (n.length > L.groupNameMax)
        fail(`a group name is at most ${L.groupNameMax} characters`);
      return n;
    };
    const note = (raw: string) => {
      if (raw.length > L.groupNoteMax)
        fail(`a group note is at most ${L.groupNoteMax} characters`);
      return raw.trim() || null;
    };
    const addTo = (itemId: string, groupId: string) => {
      const c = item(itemId);
      if (c.groupIds!.includes(groupId)) return;
      touchItem(itemId, {
        ...c,
        groupIds: [...c.groupIds!, groupId],
        suggestedGroupIds: c.suggestedGroupIds!.filter((g) => g !== groupId),
      });
    };
    const removeFrom = (itemId: string, groupId: string) => {
      const c = item(itemId);
      if (!c.groupIds!.includes(groupId)) return;
      touchItem(itemId, {
        ...c,
        groupIds: c.groupIds!.filter((g) => g !== groupId),
      });
    };

    switch (op.op) {
      case "group.create": {
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
        touchGroup(next);
        break;
      }
      case "group.archive": {
        const g = group(op.groupId, true);
        if (!g.archived) touchGroup({ ...g, archived: true });
        break;
      }
      case "group.merge": {
        if (op.fromId === op.intoId) fail("a group cannot merge into itself");
        const from = group(op.fromId);
        const into = group(op.intoId);
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
        if (op.note.length > L.itemNoteMax)
          fail(`an item note is at most ${L.itemNoteMax} characters`);
        const c = item(op.itemId);
        const { note: _old, ...rest } = c;
        touchItem(
          op.itemId,
          op.note.trim() ? { ...rest, note: op.note.trim() } : rest
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
      default: {
        const never: never = op;
        fail(`unknown edit ${(never as { op: string }).op}`);
      }
    }
  });
  return { state, changedGroupIds, changedItemIds, createdGroupIds };
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
  };
}

/** Apply the person's edits atomically. Bad op ⇒ BAD_REQUEST, nothing written. */
export async function curateLibrary(args: {
  database?: LibraryDb;
  userId: string;
  ops: readonly LibraryCurateOp[];
}): Promise<LibraryCurateResult> {
  const database = args.database ?? defaultDb;
  const written = await database.transaction(async (tx) => {
    const t = tx as unknown as LibraryDb;
    // Every group of the person (keys must stay unique; ids are validated).
    const groupRows = await listLibraryGroupRows({
      database: t,
      userId: args.userId,
    });
    const groups = new Map(groupRows.map((g) => [g.id, toCurateGroup(g)]));
    // Items: the ones named, plus every member of a group being merged.
    const ids = new Set(itemIdsOf(args.ops));
    for (const op of args.ops) {
      if (op.op !== "group.merge" || !groups.has(op.fromId)) continue;
      const members = await t
        .select({ id: documents.id })
        .from(documents)
        .where(and(libraryItemsWhere(args.userId), inGroupSql(op.fromId)));
      for (const m of members) ids.add(m.id);
    }
    const rows = await loadLibraryItemRows({
      database: t,
      userId: args.userId,
      ids: [...ids],
      forUpdate: true,
    });
    const items = new Map(
      rows.map((r) => [r.id, readLibraryCuration(r.metadata)])
    );

    let change: LibraryCurateChange;
    try {
      change = applyLibraryCurateOps({ groups, items }, args.ops);
    } catch (err) {
      if (err instanceof LibraryCurateError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
      throw err;
    }

    // Insert new groups first: their real ids replace the placeholders.
    const realId = new Map<string, string>();
    for (const placeholder of change.createdGroupIds) {
      const g = change.state.groups.get(placeholder)!;
      const [row] = await t
        .insert(libraryGroups)
        .values({
          userId: args.userId,
          key: g.key,
          name: g.name,
          note: g.note,
          origin: "user",
          outputs: g.outputs,
          buildProposalIds: [],
        })
        .returning({ id: libraryGroups.id });
      realId.set(placeholder, row!.id);
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
      const c = change.state.items.get(id)!;
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
        })
        .where(and(libraryItemsWhere(args.userId), eq(documents.id, id)));
    }
    return {
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
  const counts = await countGroups({
    database,
    userId: args.userId,
    groups: rows,
  });
  return {
    ...written,
    groups: rows.map((r) => toGroupView(r, counts.get(r.id))),
  };
}
