/**
 * ScopedDb — read AND write access that is scoped to an AccessContext
 * automatically.
 *
 * READS — `scopedDb(access).findMany(table, { where, with, ... })` looks up the
 * table's registered VisibilityRule and AND-s its predicate onto the caller's
 * `where`, so a route physically cannot return rows the identity may not see. A
 * table with no registration throws (see getVisibilityEntry) — declaration is
 * mandatory, which is what makes the scoping structural rather than opt-in.
 *
 * For queries the relational API can't express (db.select() + joins), use
 * `.predicate(table)` to get the raw WHERE and compose it yourself.
 *
 * WRITES — `scopedDb(access).mutate(table)` is the write-side companion. It
 * carries the SAME declaration-or-throw guarantee (an unregistered table throws)
 * and gates every mutation through `assertWorkspaceWrite` on the *loaded row's*
 * workspace — never a caller-supplied workspaceId. See {@link ScopedMutation}.
 */

import { db } from "@synap/database";
import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { TRPCError } from "@trpc/server";
import type { AccessContext } from "./context.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
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

  /**
   * The write door. Returns a {@link ScopedMutation} bound to `table` for the
   * current identity. Throws immediately if `table` is not registered in the
   * visibility registry — the same declaration-or-throw guarantee the read path
   * enforces, so a scoped table cannot be written without a declared scope.
   */
  mutate(table: object): ScopedMutation {
    return new ScopedMutation(this.access, table);
  }
}

/** Minimal shape of the columns a mutation gate reads off the loaded row. */
interface GateRow {
  workspaceId?: string | null;
  userId?: string | null;
  ownerId?: string | null;
}

/**
 * ScopedMutation — a guaranteed-gated write handle for one scoped table.
 *
 * Signature (mirrors the read ergonomics `findMany(table, opts)`):
 *
 *   scopedDb(access).mutate(table).update(id, patch)  → gate on the LOADED row,
 *                                                        then UPDATE that row.
 *   scopedDb(access).mutate(table).delete(id)         → gate on the LOADED row,
 *                                                        then DELETE that row.
 *   scopedDb(access).mutate(table).insert(row)        → gate on the row's TARGET
 *                                                        workspace, then INSERT.
 *
 * The gate is `assertWorkspaceWrite` keyed on the row's OWN `workspaceId`
 * (loaded from the DB for update/delete; taken from the values for insert),
 * never a request-supplied workspaceId — closing the cross-workspace WRITE-leak
 * class structurally. update/delete first load the row by id through the
 * registered relational query; a missing row throws NOT_FOUND. Construction
 * throws if the table is unregistered (declaration is mandatory).
 */
export class ScopedMutation {
  constructor(
    private readonly access: AccessContext,
    private readonly table: object
  ) {
    // Declaration-or-throw: identical guarantee to the read path.
    getVisibilityEntry(table);
  }

  private idColumn(): AnyPgColumn {
    const col = (this.table as Record<string, unknown>).id;
    if (!col) {
      throw new Error(
        "ScopedDb.mutate: table has no `id` column to key the mutation on."
      );
    }
    return col as AnyPgColumn;
  }

  private async loadRow(id: string): Promise<GateRow> {
    const entry = getVisibilityEntry(this.table);
    const row = (await entry.query().findFirst({
      where: eq(this.idColumn(), id),
    })) as GateRow | undefined;
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Row not found for this mutation.",
      });
    }
    return row;
  }

  /**
   * Gate against the row's OWN workspace/owner — the loaded row for update/
   * delete, or the values being inserted. `ownerId` folds the two owner-column
   * conventions (`userId` on data tables, `ownerId` where present); when a table
   * has neither, `assertWorkspaceWrite` denies a pod-wide (NULL-workspace) row
   * as system-managed.
   */
  private async gate(row: GateRow): Promise<void> {
    await assertWorkspaceWrite(db, this.access.userId, {
      workspaceId: row.workspaceId,
      ownerId: row.userId ?? row.ownerId,
    });
  }

  /** Load the row by id, gate on its workspace, then apply `patch`. */
  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.loadRow(id);
    await this.gate(row);
    await db
      .update(this.table as any)
      .set(patch)
      .where(eq(this.idColumn(), id));
  }

  /** Load the row by id, gate on its workspace, then delete it. */
  async delete(id: string): Promise<void> {
    const row = await this.loadRow(id);
    await this.gate(row);
    await db.delete(this.table as any).where(eq(this.idColumn(), id));
  }

  /** Gate on the row's target workspace, then insert it. */
  async insert(row: Record<string, unknown>): Promise<void> {
    await this.gate(row as GateRow);
    await db.insert(this.table as any).values(row);
  }
}

export function scopedDb(access: AccessContext): ScopedDb {
  return new ScopedDb(access);
}
