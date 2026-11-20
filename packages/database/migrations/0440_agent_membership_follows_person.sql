-- 0440 — an agent keeps no membership of a space its person is not a member
-- of (finding 747c485f, consolidation W0 security interim).
--
-- The write gate checks the ACTING agent's own `workspace_members` row
-- (`verifyWorkspaceAccess` → `verifyPermission` on `agentUserId || userId`).
-- Removing a person from a space deleted only the person's row, so the agents
-- they operate kept writing there. `WorkspaceMemberRepository.remove` now
-- removes those agents' rows with the person's; this deletes the rows the old
-- removals left behind.
--
-- "The person an agent operates for" is the canonical reading of
-- `utils/owner-person.ts` (`personOfOwner`): `users.created_by_user_id` of a
-- `user_type = 'agent'` row. An agent with no person (NULL) is a pod-wide
-- agent nobody owns: untouched. Idempotent: a second run finds nothing.

DELETE FROM "workspace_members" AS wm
USING "users" AS a
WHERE wm."user_id" = a."id"
  AND a."user_type" = 'agent'
  AND a."created_by_user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "workspace_members" AS pm
    WHERE pm."workspace_id" = wm."workspace_id"
      AND pm."user_id" = a."created_by_user_id"
  );
