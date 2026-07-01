-- 0165_intelligence_services_is_default.sql
--
-- The pod's SELECTED default intelligence service. A pod can register ANY number
-- of intelligence services (BYO agent); the canonical resolver
-- (resolveIntelligenceService / getDefaultActiveService) picks the `is_default`
-- one when no workspace/user preference applies. Switching the pod's IS = flip
-- this flag (setDefaultIntelligenceService). Partial-unique so at most one service
-- is the default per pod.

ALTER TABLE "intelligence_services"
  ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;

-- At most one default per pod.
CREATE UNIQUE INDEX IF NOT EXISTS "intelligence_services_one_default_idx"
  ON "intelligence_services" ("is_default") WHERE "is_default" = true;

-- Backfill: if nothing is marked default yet, promote the most-recently-updated
-- active + enabled service so the resolver has a deterministic selection.
UPDATE "intelligence_services" SET "is_default" = true
WHERE "service_id" = (
  SELECT "service_id" FROM "intelligence_services"
  WHERE "status" = 'active' AND "enabled" = true
  ORDER BY "updated_at" DESC LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "intelligence_services" WHERE "is_default" = true);
