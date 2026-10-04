/**
 * Account recovery codes — pod-local, one-time "look-up secrets" that let a
 * person back into THIS pod's account when every other sign-in is lost.
 *
 * Founder-validated plan (account-recovery P1, 2026-10-04): codes are issued in
 * batches of 10, shown ONCE, and never leave the pod — not to the Control Plane,
 * not to the Intelligence Service, not to a log. Only a hash is stored.
 *
 *   code_hash — `scrypt$N$r$p$<salt b64url>$<hash b64url>`. Node's built-in
 *               scrypt (memory-hard; no argon2 dependency exists in this repo).
 *               Every code of a batch shares the batch salt, so a redeem costs
 *               exactly ONE derivation whatever the batch size.
 *   batch_id  — a regenerate inserts a new batch and deletes the old one in the
 *               same transaction; only one batch per user exists.
 *   used_at   — NULL = unused. Set atomically at redeem
 *               (`UPDATE … WHERE used_at IS NULL RETURNING`) so two concurrent
 *               redeems of one code cannot both win.
 *
 * Read and written only by `apps/api/src/routers/account-recovery.ts`.
 */

import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const accountRecoveryCodes = pgTable(
  "account_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    batchId: uuid("batch_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ userIdx: index("account_recovery_codes_user_idx").on(t.userId) })
);

export type AccountRecoveryCode = typeof accountRecoveryCodes.$inferSelect;
export type AccountRecoveryCodeInsert =
  typeof accountRecoveryCodes.$inferInsert;
