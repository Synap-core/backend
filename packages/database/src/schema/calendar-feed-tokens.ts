/**
 * Personal ICS calendar-feed tokens.
 *
 * One live token per user (v1). The plaintext token is shown once at
 * mint/rotate; only the sha256 hex lookup hash is stored.
 */

import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const calendarFeedTokens = pgTable("calendar_feed_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),

  // v1: one live token per user.
  userId: text("user_id").notNull().unique(),

  // sha256(plaintext) hex — indexed equality lookup. Never store plaintext.
  tokenLookupHash: text("token_lookup_hash").notNull().unique(),

  // First 8 chars of the plaintext, for the status surface (not a secret).
  tokenPrefix: text("token_prefix"),

  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  lastAccessedAt: timestamp("last_accessed_at", {
    mode: "date",
    withTimezone: true,
  }),
  revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
});

export type CalendarFeedToken = typeof calendarFeedTokens.$inferSelect;
export type NewCalendarFeedToken = typeof calendarFeedTokens.$inferInsert;

/** @internal For monorepo usage — schema composition in the API layer */
export const insertCalendarFeedTokenSchema =
  createInsertSchema(calendarFeedTokens);
/** @internal For monorepo usage — schema composition in the API layer */
export const selectCalendarFeedTokenSchema =
  createSelectSchema(calendarFeedTokens);
