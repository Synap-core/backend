/**
 * The ONE door to `account_recovery_codes` (0294).
 *
 * Holds hashes only — hashing, comparison and every policy decision live in
 * `apps/api/src/account-recovery/`. This repository answers "which hashes",
 * "claim this one" and "replace the batch", and nothing else.
 *
 * Every read THROWS on failure: a caller that cannot tell "no codes" from
 * "the read failed" would tell a locked-out person their codes don't exist.
 */

import { and, asc, count, eq, isNull, min, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db } from "../client-pg.js";
import { accountRecoveryCodes } from "../schema/account-recovery-codes.js";

export interface UnusedRecoveryCode {
  id: string;
  codeHash: string;
}

export interface RecoveryCodeSummary {
  total: number;
  remaining: number;
  createdAt: Date | null;
}

export class AccountRecoveryCodeRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  /**
   * Replace the user's batch: the old batch (used or not) is deleted and the
   * new one inserted in ONE transaction, so a crash can never leave two live
   * batches or none-with-the-old-one-gone.
   */
  async replaceBatch(
    userId: string,
    batchId: string,
    codeHashes: readonly string[],
    createdAt: Date
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(accountRecoveryCodes)
        .where(eq(accountRecoveryCodes.userId, userId));
      if (codeHashes.length === 0) return;
      await tx.insert(accountRecoveryCodes).values(
        codeHashes.map((codeHash) => ({
          userId,
          batchId,
          codeHash,
          createdAt,
        }))
      );
    });
  }

  /** The user's unused codes, oldest first. */
  async listUnused(userId: string): Promise<UnusedRecoveryCode[]> {
    return this.db
      .select({
        id: accountRecoveryCodes.id,
        codeHash: accountRecoveryCodes.codeHash,
      })
      .from(accountRecoveryCodes)
      .where(
        and(
          eq(accountRecoveryCodes.userId, userId),
          isNull(accountRecoveryCodes.usedAt)
        )
      )
      .orderBy(asc(accountRecoveryCodes.createdAt), asc(accountRecoveryCodes.id));
  }

  /**
   * Mark one code used. Atomic: `WHERE used_at IS NULL` means of two
   * concurrent redeems of the same code exactly one gets `true`.
   */
  async claim(id: string, usedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(accountRecoveryCodes)
      .set({ usedAt })
      .where(
        and(eq(accountRecoveryCodes.id, id), isNull(accountRecoveryCodes.usedAt))
      )
      .returning({ id: accountRecoveryCodes.id });
    return rows.length === 1;
  }

  /**
   * Undo a claim whose recovery could not be completed (Kratos refused), so a
   * pod-side outage never burns the person's code. Only the claim WE made is
   * released — matched on the exact `used_at` we wrote.
   */
  async release(id: string, usedAt: Date): Promise<void> {
    await this.db
      .update(accountRecoveryCodes)
      .set({ usedAt: null })
      .where(
        and(
          eq(accountRecoveryCodes.id, id),
          eq(accountRecoveryCodes.usedAt, usedAt)
        )
      );
  }

  async summary(userId: string): Promise<RecoveryCodeSummary> {
    const [row] = await this.db
      .select({
        total: count(),
        remaining: sql<number>`count(*) filter (where ${accountRecoveryCodes.usedAt} is null)`,
        createdAt: min(accountRecoveryCodes.createdAt),
      })
      .from(accountRecoveryCodes)
      .where(eq(accountRecoveryCodes.userId, userId));
    const createdAt = row?.createdAt ?? null;
    return {
      total: Number(row?.total ?? 0),
      remaining: Number(row?.remaining ?? 0),
      createdAt:
        createdAt === null
          ? null
          : createdAt instanceof Date
            ? createdAt
            : new Date(createdAt as unknown as string),
    };
  }

  /** Pod-level fact for the unauthenticated doors read: does ANY account hold an unused code? */
  async anyUnused(): Promise<boolean> {
    const rows = await this.db
      .select({ id: accountRecoveryCodes.id })
      .from(accountRecoveryCodes)
      .where(isNull(accountRecoveryCodes.usedAt))
      .limit(1);
    return rows.length > 0;
  }
}
