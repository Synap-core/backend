/**
 * Visibility registry — the single source of truth for "how is this table
 * scoped to an identity?".
 *
 * Each scoped table declares its rule ONCE (in registry.ts). `ScopedDb` reads
 * the registry to auto-apply the right WHERE predicate, and throws on any table
 * that hasn't registered — so you cannot read a scoped table without having
 * declared how it's scoped. That declaration-or-throw is the structural
 * guarantee that replaces "every route remembers to scope itself".
 */

import { and, eq } from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import type { AccessContext } from "./context.js";

/**
 * How a table's rows map to who may see them. Add a variant when a real table
 * needs a shape these don't cover — not before (a rule with no registered
 * consumer is dead abstraction).
 */
export type VisibilityRule =
  /**
   * SHARED workspace data: visible if the row's workspace is pod-wide (NULL,
   * readable by everyone) or one the user belongs to — narrowed by the active
   * lens (`access.workspaceLens`). Use for config/shared rows (automations,
   * channels, relation-defs…). NOT for user-private rows — NULL would leak them
   * pod-wide; use `workspaceOwned` for those.
   */
  | {
      kind: "workspace";
      workspaceColumn: AnyPgColumn;
      /**
       * Keep pod-wide globals (workspaceId NULL) visible even when a SPECIFIC
       * workspace lens is active. Default false → a focused workspace shows only
       * its own rows. Set true ONLY for substrate config that every workspace
       * needs (builtin widgets, base relation-defs). At the user-wide/no-lens
       * view globals are always visible regardless.
       */
      includeGlobalsInLens?: boolean;
    }
  /**
   * PRIVATE workspace data: the workspace lens AND the row is owned by the user.
   * The `userId` floor means a NULL-workspace (unfiled) row stays visible only
   * to its owner, never pod-wide. Use for entities/notes/documents etc.
   *
   * PLANNED: no table registers this kind yet — it is the landing zone for the
   * user-private tables in the in-progress consolidation (first consumer =
   * entities/documents). Kept ahead of its consumer deliberately, not by
   * oversight; unit-tested in access.test.ts. Wire or remove when that wave lands.
   */
  | {
      kind: "workspaceOwned";
      workspaceColumn: AnyPgColumn;
      userColumn: AnyPgColumn;
      includeGlobalsInLens?: boolean;
    }
  /** Visible only to the owning user. */
  | { kind: "user"; userColumn: AnyPgColumn }
  /** No restriction — globally readable (e.g. system catalogs). */
  | { kind: "podWide" }
  /**
   * Escape hatch for a table whose visibility can't be expressed by the shapes
   * above (e.g. `profiles`: a 4-way scope enum + a grant-table EXISTS). The
   * predicate is lens- and user-aware via the passed `AccessContext`. Keep these
   * rare — one real consumer each, predicate co-located with the table's repo.
   *
   * PLANNED: no table registers this kind yet — first consumer = `profiles`
   * (whose reads still flow through ProfileRepository.getAccessibleProfiles, NOT
   * scopedDb, today; see registry.ts). Ahead of its consumer deliberately;
   * unit-tested in access.test.ts. Wire or remove when the profiles wave lands.
   */
  | {
      kind: "custom";
      predicate: (access: AccessContext) => SQL | undefined;
    };

/**
 * Minimal shape of a Drizzle relational-query namespace (`db.query.<table>`).
 *
 * Config params are `any` for the SAME reason `DatabaseClient` is `any` in
 * types/context.ts: Drizzle's `RelationalQueryBuilder` generics can't be
 * structurally abstracted without losing assignability (its findMany/findFirst
 * configs are deeply table-specific). We only ever pass {where, with, orderBy,
 * limit, offset, columns}; ScopedDb re-narrows the result via its own generic.
 */
export interface RelationalQuery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany: (config?: any) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst: (config?: any) => Promise<any>;
}

export interface VisibilityEntry {
  /** The Drizzle table object — used as the registry key (reference identity). */
  table: object;
  /** Thunk returning the `db.query.<table>` namespace this table is read through. */
  query: () => RelationalQuery;
  rule: VisibilityRule;
}

const REGISTRY = new Map<object, VisibilityEntry>();

export function registerVisibility(entry: VisibilityEntry): void {
  REGISTRY.set(entry.table, entry);
}

export function getVisibilityEntry(table: object): VisibilityEntry {
  const entry = REGISTRY.get(table);
  if (!entry) {
    throw new Error(
      "ScopedDb: this table is not registered in the visibility registry. " +
        "Every workspace/user-scoped table MUST declare a VisibilityRule in " +
        "access/registry.ts before it can be read through scopedDb()."
    );
  }
  return entry;
}

/** True once `table` has a registered rule (used by tests / tripwires). */
export function isRegistered(table: object): boolean {
  return REGISTRY.has(table);
}

/**
 * The Drizzle WHERE predicate that scopes `rule`'s table to what `access` may
 * see, or `undefined` for pod-wide (no restriction). Identity-agnostic: an
 * operator and an agent are scoped by the same rules — both carry a `userId`.
 */
export function visibilityPredicate(
  rule: VisibilityRule,
  access: AccessContext
): SQL | undefined {
  switch (rule.kind) {
    case "podWide":
      return undefined;
    case "user":
      return eq(rule.userColumn, access.userId);
    case "workspace":
      return workspaceLensWhere(
        rule.workspaceColumn,
        access.userId,
        access.workspaceLens,
        { includeGlobals: rule.includeGlobalsInLens }
      );
    case "workspaceOwned":
      return and(
        eq(rule.userColumn, access.userId),
        workspaceLensWhere(
          rule.workspaceColumn,
          access.userId,
          access.workspaceLens,
          { includeGlobals: rule.includeGlobalsInLens }
        )
      );
    case "custom":
      return rule.predicate(access);
  }
}

/** Compose a visibility predicate with a caller's extra `where` via AND. */
export function withVisibility(
  predicate: SQL | undefined,
  where: SQL | undefined
): SQL | undefined {
  if (predicate && where) return and(predicate, where);
  return predicate ?? where;
}
