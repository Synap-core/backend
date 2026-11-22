-- 0450 — an agent is never a member of a space or a project.
--
-- An agent acts through the membership of its person (the person its key is
-- linked to; for an agent id read on its own, `users.created_by_user_id`:
-- `membershipHolderIds`, `utils/owner-person.ts`) intersected with its key's
-- grant. Nothing writes an agent seat any more (enrolment, join requests,
-- track-space grants, app reach sync, setup, agent creation, forms), and the
-- membership reads ignore one, so the rows left behind are deleted here.
--
-- A pending workspace join an agent filed can no longer be decided (its
-- executor is gone): it ends as expired, nobody deciding it, with the same
-- `data.ended` stamp `transitionProposal` writes. Idempotent: a second run
-- finds nothing.

DELETE FROM "workspace_members" AS wm
USING "users" AS u
WHERE u."id" = wm."user_id"
  AND u."user_type" = 'agent';

DELETE FROM "project_members" AS pm
USING "users" AS u
WHERE u."id" = pm."user_id"
  AND u."user_type" = 'agent';

UPDATE "proposals"
SET "status" = 'expired',
    "updated_at" = now(),
    "data" = COALESCE("data", '{}'::jsonb) || jsonb_build_object(
      'ended',
      jsonb_build_object('reason', 'lapsed', 'by', 'system', 'at', now())
    )
WHERE "target_type" = 'workspace'
  AND "proposal_type" = 'join'
  AND "status" = 'pending';
