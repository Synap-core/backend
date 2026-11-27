-- 0460: a person's sessions newest first, without the automation rows.
--
-- Decision 90897bca (founder, 27 Nov 2026): agents reading the latest
-- sessions get no automation sessions until they ask for them. The agent
-- list and graph doors (`synap_list_sessions`, `synap_get_work_graph`, Hub
-- `GET /focus-sessions`, `GET /focus-sessions/graph`) now leave out, when no
-- `kind` is named, every session an automation opened that no person took on
-- (not accepted from triage, not a scheduled appointment, not a receipt):
-- `notAutomationSessionWhere`, services/focus-sessions/session-kind.ts.
--
-- Automation rows are 60,781 of the 64,312 sessions on the founder's pod
-- (12,366 in the last 7 days). With no index leading with user_id AND ordered
-- by started_at, each list read walked every row of the person through
-- `idx_focus_sessions_user_id` and sorted them: 14,761 rows (17-23 ms) for the
-- founder, 49,390 (50 ms) for the agent that owns the automation, and growing
-- by about 12,000 a week.
--
-- This partial index holds only the rows an automation did NOT open, in the
-- list's own order, so the default read is one descent that stops at the
-- page. The WHERE below is the exact expression `notAutomationSessionWhere`
-- renders (raw constants, same parenthesisation): Postgres uses a partial
-- index only when the query's WHERE carries its predicate. Change both
-- together (`session-kind.not-automation-index.pglite.test.ts` pins it).
-- Automation inserts skip the index (their row fails its predicate).
--
-- Plain CREATE INDEX (not CONCURRENTLY: the runner wraps each migration in a
-- transaction). About 3,500 rows qualify. Idempotent.

CREATE INDEX IF NOT EXISTS "idx_focus_sessions_user_started_not_automation"
  ON "focus_sessions" ("user_id", "started_at" DESC, "id" DESC)
  WHERE NOT coalesce((("origin" = 'automation' OR ("metadata" #>> '{automationRunId}' IS NOT NULL or "metadata" #>> '{automationId}' IS NOT NULL)) AND "metadata" #>> '{triage,acceptedAt}' IS NULL AND "status" <> 'scheduled' AND "metadata" #>> '{kind}' IS DISTINCT FROM 'agent-proposal-package'), false);
