-- 0447 — the status columns of the declared machines that had no CHECK store
-- only their declared words (`@synap-core/types/units` machines.ts):
-- automations, automation_runs, playbooks, session_stage_runs. chat_turns and
-- installations already have theirs.
--
-- Stored words are kept. Each CHECK is added NOT VALID and validated when no
-- row holds a word outside the set. A pod that holds one does not fail the
-- deploy: the CHECK stays NOT VALID (every new write is checked, old rows are
-- not, and an UPDATE of such a row is refused) and a NOTICE names the values.
-- Idempotent. Fresh installs get the same CHECKs from 0000_baseline_schema.sql.

DO $$
DECLARE
  spec record;
  stray text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('automations', 'automations_status_check',
       ARRAY['draft', 'active', 'paused', 'error', 'archived']),
      ('automation_runs', 'automation_runs_status_check',
       ARRAY['running', 'completed', 'failed', 'cancelled', 'skipped', 'blocked_by_policy', 'waiting_on_you']),
      ('playbooks', 'playbooks_status_check',
       ARRAY['draft', 'active', 'paused', 'archived']),
      ('session_stage_runs', 'session_stage_runs_status_check',
       ARRAY['running', 'waiting_tools', 'waiting_child', 'waiting_start', 'unreached', 'done', 'failed', 'cancelled'])
    ) AS t(tbl, con, allowed)
  LOOP
    CONTINUE WHEN to_regclass(spec.tbl) IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = spec.con AND conrelid = to_regclass(spec.tbl)
    );
    -- NOT VALID first (a short lock), then VALIDATE (no write lock while it
    -- scans) when no row holds a stray word.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("status" = ANY (%L::text[])) NOT VALID',
      spec.tbl, spec.con, spec.allowed
    );
    EXECUTE format(
      'SELECT string_agg(DISTINCT "status", '', '') FROM %I WHERE "status" <> ALL ($1)',
      spec.tbl
    ) INTO stray USING spec.allowed;
    IF stray IS NULL THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec.tbl, spec.con);
    ELSE
      RAISE NOTICE '0447: % holds undeclared status values (%); % added NOT VALID',
        spec.tbl, stray, spec.con;
    END IF;
  END LOOP;
END $$;
