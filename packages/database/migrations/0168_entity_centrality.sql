-- 0168_entity_centrality.sql
--
-- Global PageRank centrality (Horizon Wave 2, Phase 3).
--
-- A SIDE table (not a column on the hot `entities` table) holding the batch-
-- computed global PageRank score per entity. Kept separate so the entities hot
-- path stays clean and the score is freely recomputable by the PageRank job
-- (packages/jobs/src/workers/pagerank-centrality.ts) — a full recompute just
-- UPSERTs every row, never touching `entities`.
--
-- One row per entity that appears in the user's relation graph. `score` is the
-- raw PageRank mass (sums to ~1 across a user's graph); Horizon normalizes it
-- to [0,1] over the candidate pool at read time, so no normalization is stored.
--
-- STRICT migration rules: IF NOT EXISTS everywhere; also mirrored into
-- 0000_baseline_schema.sql and asserted in schema-coherence.ts.

CREATE TABLE IF NOT EXISTS "entity_centrality" (
  "entity_id"   uuid        PRIMARY KEY
                REFERENCES "entities"("id") ON DELETE CASCADE,
  "user_id"     text        NOT NULL,
  "score"       double precision NOT NULL DEFAULT 0,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Defensive ADD COLUMN for pods that somehow have an older-shaped table.
ALTER TABLE "entity_centrality" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "entity_centrality" ADD COLUMN IF NOT EXISTS "score" double precision NOT NULL DEFAULT 0;
ALTER TABLE "entity_centrality" ADD COLUMN IF NOT EXISTS "computed_at" timestamp with time zone NOT NULL DEFAULT now();

-- The job recomputes per user; Horizon reads by entity_id (PK). This index
-- serves the per-user UPSERT/prune and any per-user analytics.
CREATE INDEX IF NOT EXISTS "idx_entity_centrality_user"
  ON "entity_centrality" ("user_id");
