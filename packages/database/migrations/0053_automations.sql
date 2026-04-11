-- Automations: workflow DAGs with trigger → step chain execution
-- Three tables: automations (definition), automation_runs (per-execution), automation_step_runs (per-step)

CREATE TABLE IF NOT EXISTS "automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "trigger_type" text NOT NULL,
  "trigger_config" jsonb NOT NULL DEFAULT '{}',
  "flow_definition" jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  "status" text NOT NULL DEFAULT 'draft',
  "error_message" text,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "run_count" integer NOT NULL DEFAULT 0,
  "success_count" integer NOT NULL DEFAULT 0,
  "failure_count" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "automations_workspace_id_idx" ON "automations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "automations_status_idx" ON "automations" ("status");
CREATE INDEX IF NOT EXISTS "automations_trigger_type_idx" ON "automations" ("trigger_type");
CREATE INDEX IF NOT EXISTS "automations_next_run_at_idx" ON "automations" ("next_run_at");
CREATE INDEX IF NOT EXISTS "automations_created_by_idx" ON "automations" ("created_by");

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "automation_id" uuid NOT NULL REFERENCES "automations"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "triggered_by" text,
  "trigger_payload" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'running',
  "error_message" text,
  "steps_completed" integer NOT NULL DEFAULT 0,
  "steps_failed" integer NOT NULL DEFAULT 0,
  "output_summary" jsonb,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "automation_runs_automation_id_idx" ON "automation_runs" ("automation_id");
CREATE INDEX IF NOT EXISTS "automation_runs_status_idx" ON "automation_runs" ("status");
CREATE INDEX IF NOT EXISTS "automation_runs_started_at_idx" ON "automation_runs" ("started_at");

CREATE TABLE IF NOT EXISTS "automation_step_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,
  "command_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "resolved_inputs" jsonb NOT NULL DEFAULT '{}',
  "output" jsonb NOT NULL DEFAULT '{}',
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "automation_step_runs_run_id_idx" ON "automation_step_runs" ("run_id");
