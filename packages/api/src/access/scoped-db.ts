/**
 * ScopedDb — read access that is scoped to an AccessContext automatically.
 *
 * `scopedDb(access).findMany(table, { where, with, ... })` looks up the table's
 * registered VisibilityRule and AND-s its predicate onto the caller's `where`,
 * so a route physically cannot return rows the identity may not see. A table
 * with no registration throws (see getVisibilityEntry) — declaration is
 * mandatory, which is what makes the scoping structural rather than opt-in.
 *
 * For queries the relational API can't express (db.select() + joins), use
 * `.predicate(table)` to get the raw WHERE and compose it yourself.
 */

import type { SQL } from "drizzle-orm";
import type { AccessContext } from "./context.js";
import {
  getVisibilityEntry,
  visibilityPredicate,
  withVisibility,
} from "./visibility.js";

export interface ScopedFindOptions {
  where?: SQL;
  with?: Record<string, unknown>;
  orderBy?: unknown;
  limit?: number;
  offset?: number;
  columns?: Record<string, boolean>;
}

export class ScopedDb {
  constructor(private readonly access: AccessContext) {}

  async findMany<T = unknown>(
    table: object,
    opts: ScopedFindOptions = {}
  ): Promise<T[]> {
    const entry = getVisibilityEntry(table);
    const { where, ...rest } = opts;
    const scoped = withVisibility(
      visibilityPredicate(entry.rule, this.access),
      where
    );
    return entry.query().findMany({ ...rest, where: scoped }) as Promise<T[]>;
  }

  async findFirst<T = unknown>(
    table: object,
    opts: ScopedFindOptions = {}
  ): Promise<T | undefined> {
    const entry = getVisibilityEntry(table);
    const { where, ...rest } = opts;
    const scoped = withVisibility(
      visibilityPredicate(entry.rule, this.access),
      where
    );
    return entry.query().findFirst({ ...rest, where: scoped }) as Promise<
      T | undefined
    >;
  }

  /** The raw visibility predicate for `table` — to compose into a db.select(). */
  predicate(table: object): SQL | undefined {
    const entry = getVisibilityEntry(table);
    return visibilityPredicate(entry.rule, this.access);
  }
}

export function scopedDb(access: AccessContext): ScopedDb {
  return new ScopedDb(access);
}
