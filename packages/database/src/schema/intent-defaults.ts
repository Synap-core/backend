/**
 * Intent Defaults Schema (0409)
 *
 * The provider a person chose to remember for an intent and a set of
 * constraints ("Use Tailnet for new sites", addendum 000e75ff §5). When
 * several installed providers fit a need, the resolver preselects this one.
 *
 * `workspace_id` NULL = every space of this person. `constraints_hash` is the
 * hash of the need's normalized constraints ('' for none), so one remembered
 * choice answers exactly the needs it was made for; `constraints` keeps the
 * readable copy. One row per (person, space, intent, constraints).
 *
 * `intent` is plain text (open vocabulary; Stage 1 slugs wait on F1).
 *
 * `public` is never remembered (addendum §7 rule 1): the
 * `intent_defaults_never_public_check` CHECK refuses a row whose constraints
 * ask for, or allow, `auth: public`. A person chooses public each time.
 *
 * Read floor = the person alone (`user`, access/registry.ts): a preference.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { capabilities } from "./capabilities.js";

export const intentDefaults = pgTable(
  "intent_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    intent: text("intent").notNull(),
    constraintsHash: text("constraints_hash").notNull().default(""),
    constraints: jsonb("constraints")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** The chosen provider; the default goes with it when it is deleted. */
    providerCapabilityId: uuid("provider_capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    scopeUnique: unique("intent_defaults_scope_unique")
      .on(table.userId, table.workspaceId, table.intent, table.constraintsHash)
      .nullsNotDistinct(),
  })
);

export type IntentDefaultRow = typeof intentDefaults.$inferSelect;
export type NewIntentDefaultRow = typeof intentDefaults.$inferInsert;
