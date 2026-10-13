/**
 * CURATE — the person's edits to an import: a note per group (every item
 * inherits it), exceptions per item (later / exclude / item note), and group
 * membership (an item may sit in several groups).
 *
 * `applyImportCurateOps` is PURE: it validates and applies the ops in order and
 * returns the new state plus the items it changed — or throws
 * {@link ImportCurateError} naming the first bad op, so nothing is written.
 * `curateImport` runs it inside ONE transaction with the session row locked:
 * the session's groups and every changed item's `importCuration` land
 * together, or not at all.
 */

import { TRPCError } from "@trpc/server";
import { db as defaultDb, documents, drizzleSql } from "@synap/database";
import {
  IMPORT_LIMITS,
  importGroupKey,
  type ImportCurateOp,
  type ImportGroup,
  type ImportItemCuration,
  type ImportPhase,
  type ImportSessionCuration,
} from "@synap-core/types/imports";
import {
  IMPORT_ITEM_CURATION_KEY,
  loadImportItemRows,
  readItemCuration,
} from "./read-model.js";
import {
  assertImportOpen,
  loadImportSession,
  writeImportCuration,
  type ImportDb,
} from "./session.js";

export class ImportCurateError extends Error {
  constructor(
    readonly opIndex: number,
    message: string
  ) {
    super(`Edit #${opIndex + 1}: ${message}`);
    this.name = "ImportCurateError";
  }
}

export interface CurateState {
  groups: ImportGroup[];
  /** Item id → curation, for every item of the import. */
  items: Map<string, ImportItemCuration>;
}

export interface CurateResult {
  state: CurateState;
  changedItemIds: Set<string>;
}

/**
 * The phase an import is in, DERIVED from its state (never set by a client):
 *   - `done`      every group with members has been built (and one was);
 *   - `building`  at least one group was built, others remain;
 *   - `curating`  groups exist (AI-proposed or the person's);
 *   - `collecting` nothing grouped yet.
 */
export function deriveImportPhase(
  groups: readonly ImportGroup[],
  items: ReadonlyMap<string, ImportItemCuration>,
  groupedAt?: string
): ImportPhase {
  const members = new Map<string, number>();
  for (const c of items.values()) {
    for (const k of c.groupKeys) members.set(k, (members.get(k) ?? 0) + 1);
  }
  const nonEmpty = groups.filter((g) => (members.get(g.key) ?? 0) > 0);
  const built = groups.filter((g) => g.builtAt);
  if (built.length > 0 && nonEmpty.every((g) => g.builtAt)) return "done";
  if (built.length > 0) return "building";
  if (groups.length > 0 || groupedAt) return "curating";
  return "collecting";
}

function cloneState(state: CurateState): CurateState {
  return {
    groups: state.groups.map((g) => ({ ...g, outputs: [...g.outputs] })),
    items: new Map(
      [...state.items].map(([id, c]) => [
        id,
        { ...c, groupKeys: [...c.groupKeys] },
      ])
    ),
  };
}

/** Apply ops in order. PURE — throws on the first invalid op. */
export function applyImportCurateOps(
  input: CurateState,
  ops: readonly ImportCurateOp[]
): CurateResult {
  const state = cloneState(input);
  const changed = new Set<string>();
  const L = IMPORT_LIMITS;

  ops.forEach((op, i) => {
    const fail = (message: string): never => {
      throw new ImportCurateError(i, message);
    };
    const group = (key: string) =>
      state.groups.find((g) => g.key === key) ?? fail(`no group "${key}"`);
    const item = (id: string) => state.items.get(id) ?? fail(`no item "${id}"`);
    const touch = (id: string, next: ImportItemCuration) => {
      state.items.set(id, next);
      changed.add(id);
    };
    const name = (raw: string) => {
      const n = raw.replace(/\s+/g, " ").trim();
      if (!n) fail("a group needs a name");
      if (n.length > L.groupNameMax)
        fail(`a group name is at most ${L.groupNameMax} characters`);
      return n;
    };

    switch (op.op) {
      case "setGroupNote": {
        const g = group(op.groupKey);
        if (op.note.length > L.groupNoteMax) {
          fail(`a group note is at most ${L.groupNoteMax} characters`);
        }
        const note = op.note.trim();
        if (note) g.note = note;
        else delete g.note;
        return;
      }
      case "setGroupOutputs": {
        const g = group(op.groupKey);
        g.outputs = [...new Set(op.outputs)];
        return;
      }
      case "renameGroup": {
        group(op.groupKey).name = name(op.name);
        return;
      }
      case "createGroup": {
        if (state.groups.length >= L.groupsMax) {
          fail(`an import holds at most ${L.groupsMax} groups`);
        }
        const n = name(op.name);
        const key = importGroupKey(
          n,
          state.groups.map((g) => g.key)
        );
        const ids = op.itemIds ?? [];
        ids.forEach(item);
        state.groups.push({
          key,
          name: n,
          origin: "user",
          outputs: ["things"],
        });
        for (const id of ids) {
          const c = item(id);
          if (!c.groupKeys.includes(key)) {
            touch(id, { ...c, groupKeys: [...c.groupKeys, key] });
          }
        }
        return;
      }
      case "mergeGroups": {
        if (op.fromKey === op.intoKey) fail("a group cannot merge into itself");
        const from = group(op.fromKey);
        const into = group(op.intoKey);
        if (!into.note && from.note) into.note = from.note;
        into.outputs = [...new Set([...into.outputs, ...from.outputs])];
        state.groups = state.groups.filter((g) => g.key !== from.key);
        for (const [id, c] of state.items) {
          if (!c.groupKeys.includes(from.key)) continue;
          const keys = c.groupKeys.filter((k) => k !== from.key);
          if (!keys.includes(into.key)) keys.push(into.key);
          touch(id, { ...c, groupKeys: keys });
        }
        return;
      }
      case "deleteGroup": {
        group(op.groupKey);
        state.groups = state.groups.filter((g) => g.key !== op.groupKey);
        for (const [id, c] of state.items) {
          if (c.groupKeys.includes(op.groupKey)) {
            touch(id, {
              ...c,
              groupKeys: c.groupKeys.filter((k) => k !== op.groupKey),
            });
          }
        }
        return;
      }
      case "addToGroup":
      case "removeFromGroup": {
        group(op.groupKey);
        for (const id of op.itemIds) {
          const c = item(id);
          const has = c.groupKeys.includes(op.groupKey);
          if (op.op === "addToGroup" && !has) {
            touch(id, { ...c, groupKeys: [...c.groupKeys, op.groupKey] });
          } else if (op.op === "removeFromGroup" && has) {
            touch(id, {
              ...c,
              groupKeys: c.groupKeys.filter((k) => k !== op.groupKey),
            });
          }
        }
        return;
      }
      case "setItemNote": {
        const c = item(op.itemId);
        if (op.note.length > L.itemNoteMax) {
          fail(`an item note is at most ${L.itemNoteMax} characters`);
        }
        const note = op.note.trim();
        const { note: _old, ...rest } = c;
        touch(op.itemId, note ? { ...rest, note } : rest);
        return;
      }
      case "setDecision": {
        for (const id of op.itemIds) {
          const c = item(id);
          if (c.decision !== op.decision)
            touch(id, { ...c, decision: op.decision });
        }
        return;
      }
      default: {
        const unknown: never = op;
        fail(`unknown edit ${(unknown as { op?: string }).op}`);
      }
    }
  });
  return { state, changedItemIds: changed };
}

/**
 * Write the curation of every changed item in ONE statement (a merge across
 * 2000 items is one round trip, not 2000). Sibling key — `intakeSource` is
 * never touched.
 */
export async function writeItemCurations(
  database: ImportDb,
  userId: string,
  curations: ReadonlyMap<string, ImportItemCuration>,
  ids: Iterable<string>
): Promise<void> {
  const byId: Record<string, ImportItemCuration> = {};
  for (const id of ids) byId[id] = curations.get(id)!;
  if (Object.keys(byId).length === 0) return;
  await database.execute(drizzleSql`
    UPDATE ${documents}
    SET metadata = COALESCE(${documents.metadata}, '{}'::jsonb)
      || jsonb_build_object(${IMPORT_ITEM_CURATION_KEY}::text, v.value)
    FROM jsonb_each(${JSON.stringify(byId)}::jsonb) AS v
    WHERE ${documents.id} = v.key::uuid AND ${documents.userId} = ${userId}`);
}

/** `imports.curate` — apply the ops atomically. */
export async function curateImport(args: {
  database?: ImportDb;
  userId: string;
  sessionId: string;
  ops: readonly ImportCurateOp[];
}): Promise<void> {
  const database = args.database ?? defaultDb;
  await database.transaction(async (tx) => {
    const session = await loadImportSession({
      database: tx as unknown as ImportDb,
      userId: args.userId,
      sessionId: args.sessionId,
      forUpdate: true,
    });
    assertImportOpen(session);
    const rows = await loadImportItemRows({
      database: tx as unknown as ImportDb,
      userId: args.userId,
      sessionId: session.id,
    });
    const items = new Map(
      rows.map((r) => [r.id, readItemCuration(r.metadata)])
    );
    let result: CurateResult;
    try {
      result = applyImportCurateOps(
        { groups: session.curation.groups, items },
        args.ops
      );
    } catch (err) {
      if (err instanceof ImportCurateError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      }
      throw err;
    }
    await writeItemCurations(
      tx as unknown as ImportDb,
      args.userId,
      result.state.items,
      result.changedItemIds
    );
    const next: ImportSessionCuration = {
      ...session.curation,
      groups: result.state.groups,
      phase: deriveImportPhase(
        result.state.groups,
        result.state.items,
        session.curation.groupedAt
      ),
    };
    await writeImportCuration({
      database: tx as unknown as ImportDb,
      userId: args.userId,
      sessionId: session.id,
      curation: next,
    });
  });
}
