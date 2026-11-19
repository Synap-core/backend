-- 0434 — apps.approved_access: an app connection's access in its v2 form
-- (app permissions W2, founder decision 51ad8d1e, plan 8189ae7c §3 Option A).
--
-- `{version: 2, permissions, read: {spaces: "all" | id[], projects: "all" |
-- id[]}, write: {spaces: id[], projects: id[]}}` — what the app may do, and
-- where, once per tier (`AppAccess`, @synap-core/types/grants). NULL = no
-- approval, or a connection whose old pairs cannot be lifted without changing
-- what it may do (it re-consents and keeps `approved_requests`).
--
-- Column only. The lift is TypeScript (`liftApprovedRequests`: the pod-wide
-- read rule, the per-tier union and the no-widen check do not belong in SQL),
-- so existing rows are filled by the backfill CLI, dry run first:
--   node dist/scripts/backfill-app-access.js            (DRY RUN)
--   node dist/scripts/backfill-app-access.js --apply
-- Until then every reader lifts the pairs at read time, so a pod that has not
-- run the backfill behaves exactly as before. `approved_requests` stays the
-- record of what was approved and is dropped only in W5.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "approved_access" jsonb;
