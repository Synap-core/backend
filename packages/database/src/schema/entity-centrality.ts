/**
 * Entity Centrality Schema — global PageRank score per entity (Horizon Phase 3).
 *
 * A SIDE table (one row per entity in the user's relation graph) holding the
 * batch-computed global PageRank score. Deliberately NOT a column on `entities`
 * so the hot table stays clean and the score is freely recomputable — the
 * PageRank job (packages/jobs/src/workers/pagerank-centrality.ts) UPSERTs every
 * row on each run.
 *
 * `score` is the raw PageRank mass (~sums to 1 across a user's graph). Horizon
 * normalizes it to [0,1] over the candidate pool at read time, so the stored
 * value is the raw score.
 */

import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";

export const entityCentrality = pgTable(
  "entity_centrality",
  {
    /** Entity this score belongs to. PK — one score per entity. */
    entityId: uuid("entity_id")
      .primaryKey()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** Owner — the graph is computed per user. */
    userId: text("user_id").notNull(),
    /** Raw global PageRank mass. Normalized to [0,1] over the pool by Horizon. */
    score: doublePrecision("score").notNull().default(0),
    /** When the last PageRank batch wrote this row. */
    computedAt: timestamp("computed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("idx_entity_centrality_user").on(table.userId),
  })
);

export type EntityCentrality = typeof entityCentrality.$inferSelect;
export type NewEntityCentrality = typeof entityCentrality.$inferInsert;
