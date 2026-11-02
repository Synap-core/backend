-- 0387: a document's scope and its refresher (Generative UI wave 1, plan
-- 678c56c4, contracts 3 and 4).
--
--   scope                   the `LensScope` a living document reads through
--                           (`@synap-core/types/lens`, `readLensScope`): pod,
--                           workspace (+ projectId), project, track or session.
--                           The host stamps it on every cell's lens; a cell
--                           never takes scope as a prop. NULL = today's
--                           behaviour (the document's workspace, else the pod).
--   refresh_automation_id   the automation bound to refresh the document (D4).
--                           Its run sessions may rewrite the document's
--                           EXISTING owner="ai" sections through the stored
--                           `document.refresher_section_update` rule; every
--                           other write is governed as before. ON DELETE SET
--                           NULL: a deleted automation unbinds itself.
--
-- No backfill. Fresh installs get the columns from 0000_baseline_schema.sql
-- (the FK is added here only, once both tables exist). Idempotent.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "scope" jsonb;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "refresh_automation_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_refresh_automation_id_fkey'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_refresh_automation_id_fkey"
      FOREIGN KEY ("refresh_automation_id") REFERENCES "automations"("id")
      ON DELETE SET NULL;
  END IF;
END $$;
