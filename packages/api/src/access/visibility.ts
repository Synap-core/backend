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
import { userVisibleWhere } from "../utils/user-visible-where.js";
import type { AccessContext } from "./context.js";

/**
 * How a table's rows map to who may see them. Add a variant when a real table
 * needs a shape these don't cover — not before (a rule with no registered
 * consumer is dead abstraction).
 */
export type VisibilityRule =
  /** Visible if the row's workspace is pod-wide (NULL) or one the user belongs to. */
  | { kind: "workspace"; workspaceColumn: AnyPgColumn }
  /** Visible only to the owning user. */
  | { kind: "user"; userColumn: AnyPgColumn }
  /** No restriction — globally readable (e.g. system catalogs). */
  | { kind: "podWide" };

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
      return userVisibleWhere(rule.workspaceColumn, access.userId);
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
