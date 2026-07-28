-- One-time BACKFILL: materialize the pod's owner/admins as members of every
-- existing pod_visible / pod_joinable workspace they lack a row on.
--
-- A pod owner/admin (canonical `isPodAdmin` notion: a member of the `pod-admin`
-- system workspace with role owner/admin) needs a `workspace_members` row on a
-- shared workspace to get WRITE there (verifyPermission → getWorkspaceMembership
-- → checkPermissionOrPropose). Workspace creation only added the CREATOR, so pod
-- admins who did not create a given pod-visible workspace hold no row and cannot
-- administer its entities inline. Going forward the workspaces.create /
-- createFromDefinition / updateMemberRole triggers materialize them; this
-- backfill repairs the workspaces that predate those triggers.
--
-- SCOPE: pod_visible / pod_joinable ONLY. A pod-visible workspace is already
-- pod-readable, so an admin member row grants no new reads; a PRIVATE workspace
-- is deliberately excluded (a member row there would widen its reads). Adding
-- `workspace_members` rows does not touch the pod-member READ floor either
-- (facetVisibilityConditions / podSharedFacetWhere key on `pod_members`).
--
-- Owner-first: the owner insert runs before the admin insert so a user who is
-- both owner and admin of the pod-admin workspace lands as `owner`; the admin
-- insert then no-ops on them (ON CONFLICT DO NOTHING never downgrades).
--
-- Idempotent + data-only (no schema change → no 0000_baseline / schema-coherence
-- edit): re-running inserts nothing. ON CONFLICT targets the
-- (workspace_id, user_id) unique index.

-- 1. Pod OWNERS → role 'owner' on every non-archived pod-visible workspace.
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT w."id", pa."user_id", 'owner'
  FROM "workspace_members" pa
  JOIN "workspaces" pod
    ON pod."id" = pa."workspace_id"
   AND pod."system_slug" = 'pod-admin'
  CROSS JOIN "workspaces" w
 WHERE pa."role" = 'owner'
   AND w."archived_at" IS NULL
   AND w."settings"->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;

-- 2. Pod ADMINS → role 'admin' on every non-archived pod-visible workspace.
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT w."id", pa."user_id", 'admin'
  FROM "workspace_members" pa
  JOIN "workspaces" pod
    ON pod."id" = pa."workspace_id"
   AND pod."system_slug" = 'pod-admin'
  CROSS JOIN "workspaces" w
 WHERE pa."role" = 'admin'
   AND w."archived_at" IS NULL
   AND w."settings"->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;
