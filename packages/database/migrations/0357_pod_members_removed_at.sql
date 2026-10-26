-- 0357 — pod_members.removed_at (pod-access floor B0, founder Q-B1 2026-10-26).
--
-- A `pod_members` row is how a person joined the pod (a pod invite). It was
-- never removed: `workspaces.removeFromPod` took the person out of every space
-- and left the row, so every reader of it (`podParticipantWhere`,
-- `podMemberWhere`, `AccessContext.podMembership`, `workspaces.isPodMember`)
-- still called a removed person a member. The founder's answer: the row is
-- access ONLY while it is live. `removeFromPod` now stamps `removed_at` when
-- the person is left with no space; accepting a new pod invite clears it.
-- Every reader goes through `livePodMemberWhere` (@synap/database
-- utils/pod-membership.ts).
--
-- Additive and nullable: the previous release neither reads nor writes it, so
-- a rollback onto this schema is safe.
--
-- BACKFILL. A live row now COUNTS as access (`hasActivePodAccess`), so a row
-- left behind by a removal before this release would let that person back in
-- (a device token, a federation receipt). Every row whose person holds no
-- space membership and no non-guest project membership is stamped removed:
-- that is what such a removal left. It also stamps a person who accepted a pod
-- invite on a pod with no ordinary space and joined nothing since; they held
-- no access before this release either (`hasActivePodAccess` ignored the row),
-- so nobody loses access they had. A new pod invite revives the row.

ALTER TABLE "pod_members" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;

UPDATE "pod_members" AS pm
   SET "removed_at" = now()
 WHERE pm."removed_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "workspace_members" wm WHERE wm."user_id" = pm."user_id"
   )
   AND NOT EXISTS (
     SELECT 1 FROM "project_members" p
      WHERE p."user_id" = pm."user_id"
        AND p."role" IS DISTINCT FROM 'guest'
   );
