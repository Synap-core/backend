-- 0440 — an agent keeps no membership of a space where a person it acts for
-- is not a member (finding 747c485f, consolidation W0 security interim).
--
-- The write gate checks the ACTING agent's own `workspace_members` row
-- (`verifyWorkspaceAccess` → `verifyPermission` on `agentUserId || userId`).
-- Removing a person from a space deleted only the person's row, so the agents
-- acting for them kept writing there. `WorkspaceMemberRepository.remove` now
-- removes those agents' rows with the person's; this deletes the rows the old
-- removals left behind.
--
-- "The agents acting for a person" is the reading of `utils/owner-person.ts`
-- `agentsActingFor`: a `user_type = 'agent'` user holding an api key whose
-- `linked_user_id` is that person (revoked keys included). NOT the creator
-- (`created_by_user_id`): the Capture agent and the Intelligence Service
-- personas are created by the pod owner but serve every member, and hold no
-- key linked to a person, so they are untouched here, as is any agent with
-- only a pod-wide (`linked_user_id` NULL) key. Idempotent: a second run finds
-- nothing.

DELETE FROM "workspace_members" AS wm
WHERE EXISTS (
  SELECT 1
  FROM "api_keys" AS k
  JOIN "users" AS a ON a."id" = k."user_id"
  WHERE k."user_id" = wm."user_id"
    AND a."user_type" = 'agent'
    AND k."linked_user_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_members" AS pm
      WHERE pm."workspace_id" = wm."workspace_id"
        AND pm."user_id" = k."linked_user_id"
    )
);
