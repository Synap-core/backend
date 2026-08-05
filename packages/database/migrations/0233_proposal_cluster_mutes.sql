-- 0233_proposal_cluster_mutes.sql
--
-- Durable, per-pod mute of a rejection SHAPE-cluster (calibration "Mark
-- expected"). Previously session-only; this persists it so a muted rejection
-- cluster stops surfacing in the rejected-clusters read across sessions.
--
-- fingerprint = the SAME computeProposalFingerprint value the rejected-clusters
-- read (proposals.groups({ status:'rejected' })) produces, so a mute matches a
-- cluster exactly. POD-SCOPED (no workspace) — a rejection shape is pod-wide,
-- like the duplicate-cluster recommender it mirrors.
--
-- SOFT UNMUTE: revoked_at NULL = active; unmute stamps it (never deletes). The
-- partial unique index guarantees at most one ACTIVE mute per fingerprint while
-- allowing a re-mute after a revoke.

CREATE TABLE IF NOT EXISTS "proposal_cluster_mutes" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fingerprint"  text NOT NULL,
  "created_by"   text NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at"   timestamp with time zone
);

-- Idempotent guard for a pre-existing table.
ALTER TABLE "proposal_cluster_mutes" ADD COLUMN IF NOT EXISTS "fingerprint" text;
ALTER TABLE "proposal_cluster_mutes" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "proposal_cluster_mutes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "proposal_cluster_mutes" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;

-- At most ONE active mute per fingerprint (pod-wide). A revoke frees the
-- fingerprint to be muted again later.
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_cluster_mutes_active_uq"
  ON "proposal_cluster_mutes" ("fingerprint")
  WHERE "revoked_at" IS NULL;
