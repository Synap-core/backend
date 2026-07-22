-- 0205_pod_members.sql — durable pod-membership identity (Membership → Visibility, Wave 1)
--
-- Today "who is in this pod" has no SSOT. A pod invite (`invites.type = 'pod'`)
-- is materialized by fanning `workspace_members` rows into EVERY existing
-- workspace — a snapshot loop, not a durable identity. `pod_members` is the
-- missing peer of `workspace_members`: one durable row per user who belongs to
-- this pod. The pod is a SINGLETON deployment (there is no `pods` table and no
-- `pod_id`), so membership is keyed on `user_id` alone.
--
-- Wave 1 is BEHAVIOR-NEUTRAL: nothing reads this table yet. Wave 2 makes the
-- read floor consult it (a `podShared` branch gated on pod-membership). Creating
-- the table + backfilling it now changes no visibility.

CREATE TABLE IF NOT EXISTS "pod_members" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    text NOT NULL,
  "pod_role"   text NOT NULL,              -- 'owner' | 'admin' | 'member'
  "invited_by" text,                       -- inviter userId (nullable)
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "pod_members" ADD COLUMN IF NOT EXISTS "user_id"    text;
ALTER TABLE "pod_members" ADD COLUMN IF NOT EXISTS "pod_role"   text;
ALTER TABLE "pod_members" ADD COLUMN IF NOT EXISTS "invited_by" text;
ALTER TABLE "pod_members" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

-- One pod-membership row per user (the pod is a singleton — no pod_id).
CREATE UNIQUE INDEX IF NOT EXISTS "pod_members_user_unique"
  ON "pod_members" ("user_id");

-- ─── Backfill (conservative) ─────────────────────────────────────────────────
-- Seed a pod_members row for every user who is known to belong to this pod.
--
-- Derivation (safe by construction, insert-owner-first so the stronger role wins
-- under ON CONFLICT DO NOTHING):
--   1. The pod OWNER — best-effort: the owner of the `pod-admin` SYSTEM workspace
--      (the singleton admin workspace). Inserted first with pod_role='owner'.
--   2. Every DISTINCT `workspaces.owner_id` — inserted as pod_role='member';
--      the owner row above already claims the (user_id) slot, so DO NOTHING keeps
--      it 'owner'.
--
-- LIMITATION (documented, not guessed): a user who joined ONLY via a past
-- `type='pod'` invite fan-out (they own no workspace) is NOT backfilled here.
-- Pod invites are DELETED from `invites` on accept (see
-- workspaces.ts acceptInvite / acceptInviteViaCp), so there is no persisted
-- "accepted pod invite" to derive from, and a pod-invitee is indistinguishable
-- in `workspace_members` from a legitimate multi-workspace member. Rather than
-- guess wrong, Wave 1 backfills only distinct workspace owners; going forward,
-- invite-acceptance writes a `pod_members` row directly (additive, this wave).

INSERT INTO "pod_members" ("user_id", "pod_role")
SELECT DISTINCT "owner_id", 'owner'
  FROM "workspaces"
 WHERE "system_slug" = 'pod-admin'
   AND "owner_id" IS NOT NULL
ON CONFLICT ("user_id") DO NOTHING;

INSERT INTO "pod_members" ("user_id", "pod_role")
SELECT DISTINCT "owner_id", 'member'
  FROM "workspaces"
 WHERE "owner_id" IS NOT NULL
ON CONFLICT ("user_id") DO NOTHING;
