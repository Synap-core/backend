/**
 * Capability intents — what a tool DOES, independent of its vendor.
 *
 * The 13 values in `ABSTRACT_VERBS` (`schema/tools.ts`) are the SEED, not the
 * vocabulary. A new kind of work is a row here. `effect` stays closed
 * (read | write | act) because a rule can key on it; the slug is open.
 * Synonyms are for finding a row, never for identity — the slug is the seat.
 *
 * Routing only. Governance still decides on the concrete verb id.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const CAPABILITY_INTENT_EFFECTS = ["read", "write", "act"] as const;
export type CapabilityIntentEffect = (typeof CAPABILITY_INTENT_EFFECTS)[number];

/** Slug seat: lowercase, digits, underscores. Same shape as the seed tokens. */
export const INTENT_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const capabilityIntents = pgTable("capability_intents", {
  slug: text("slug").primaryKey(),
  effect: text("effect", { enum: ["read", "write", "act"] }).notNull(),
  statement: text("statement").notNull(),
  synonyms: text("synonyms").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export type CapabilityIntent = typeof capabilityIntents.$inferSelect;
export type NewCapabilityIntent = typeof capabilityIntents.$inferInsert;
