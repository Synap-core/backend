/**
 * Daily Asks Schema (0367) — the ONE count of the daily ask budget (D7,
 * founder-approved 28 Oct 2026).
 *
 * The first time an ask is headlined on a person's local day (a needs-you read
 * of their whole pod, or a push), it is stamped here, until the person's
 * `daily_ask_count` ceiling (`governance_ceilings`, default 5) is reached for
 * that day. Stamped asks are the day's "Asks"; the rest wait in "Later", which
 * never pushes and never auto-approves. Every surface reads these rows instead
 * of re-ranking, so the badge, Home, the phone and pod-admin say one number.
 *
 * `itemKind` + `itemId` name the ask unit (`ASK_ITEM_KINDS`,
 * services/governance/ask-budget.ts): `proposal` (a proposal id — a cluster is
 * stamped through one member), `slot` (an owed slot's signal id) or
 * `access-request` (its signal id).
 *
 * Read floor = the person (`user_id`, access/registry.ts).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const dailyAsks = pgTable(
  "daily_asks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** The person's local day (`YYYY-MM-DD`, their `users.timezone`). */
    day: date("day", { mode: "string" }).notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: text("item_id").notNull(),
    /** Its position in the day's ranking when it was stamped (0-based). */
    rank: integer("rank").notNull(),
    surfacedAt: timestamp("surfaced_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userDayItemUniq: uniqueIndex("daily_asks_user_day_item_uniq").on(
      table.userId,
      table.day,
      table.itemKind,
      table.itemId
    ),
    userDayIdx: index("daily_asks_user_day_idx").on(table.userId, table.day),
  })
);

export type DailyAsk = typeof dailyAsks.$inferSelect;
export type NewDailyAsk = typeof dailyAsks.$inferInsert;
