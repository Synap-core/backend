/**
 * Needs (0426) — what a space needs filled, once, by one provider (founder
 * decisions D2 and D3, 16 Nov 2026).
 *
 * A need is a SEAT ("code host", "deploy target", "payments"): a named group
 * of capability intents, coarser than an intent because an intent cannot tell
 * payments from analytics from a code host. A capability pack declares which
 * needs it fills (`fills`); a space binds each need once, on
 * `installation_bindings` (a row with no installation).
 *
 * Open and curated like `capability_intents`: a new need is a row. A need is
 * never renamed, only aliased (`aliases`). Mirrored in
 * `@synap-core/types/needs` and the control plane's seed copy, each with a
 * parity guard on migration 0426.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const needs = pgTable("needs", {
  /** Lowercase kebab slug; never renamed. */
  slug: text("slug").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  /** The `capability_intents` slugs a provider of this need serves. */
  intents: text("intents").array().notNull().default([]),
  /** Other names that resolve to this slug. */
  aliases: text("aliases").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export type NeedRow = typeof needs.$inferSelect;
export type NewNeedRow = typeof needs.$inferInsert;
