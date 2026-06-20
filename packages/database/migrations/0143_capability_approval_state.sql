-- 0143 — Per-capability approval state on `tools` and `skills`.
--
-- Lifts the `mcp_servers.approved` pattern onto tools + skills as a BOOLEAN
-- (orthogonal to `status`, which stays lifecycle/health). A capability is born
-- NOT approved (DEFAULT false) so a freshly-created / AI-seeded capability can't
-- execute until an owner approves it.
--
-- Grandfather contract: the blanket one-time UPDATE below flips every row that
-- EXISTS at migration time to approved=true (so nothing currently runnable
-- breaks), while DEFAULT false means every row inserted AFTER this migration is
-- born draft. Defensive/idempotent per backend-rules (ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS).

-- ── Tools ────────────────────────────────────────────────────────────────────
ALTER TABLE "tools"  ADD COLUMN IF NOT EXISTS "approved" boolean NOT NULL DEFAULT false;
-- One-time grandfather of the pre-existing population.
UPDATE "tools"  SET "approved" = true WHERE "approved" = false;
CREATE INDEX IF NOT EXISTS "idx_tools_approved"  ON "tools"  ("approved");

-- ── Skills ───────────────────────────────────────────────────────────────────
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "approved" boolean NOT NULL DEFAULT false;
-- One-time grandfather of the pre-existing population.
UPDATE "skills" SET "approved" = true WHERE "approved" = false;
CREATE INDEX IF NOT EXISTS "idx_skills_approved" ON "skills" ("approved");
