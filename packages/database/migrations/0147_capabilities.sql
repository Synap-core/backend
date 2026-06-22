-- 0147_capabilities.sql
--
-- Capability CONTAINERS. A Capability is a named, first-class bundle of what
-- your agents can do — it groups a set of parts (Connections/tools, Skills,
-- Built-ins). The container itself executes nothing; its parts attach via the
-- existing polymorphic `links` table as
--   `tool|skill|command --member_of--> capability`
-- (mirroring `automation --member_of--> playbook`). `links` columns are
-- free-text, so only the new `capabilities` table needs DDL here.
--
-- Born NOT approved (like tools/mcp_servers): an AI-created bundle is untrusted
-- until an owner approves it. Nullable workspace_id = pod-wide.

CREATE TABLE IF NOT EXISTS "capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid,
  "created_by" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "approved" boolean NOT NULL DEFAULT false,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_capabilities_workspace_id" ON "capabilities" ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_capabilities_created_by" ON "capabilities" ("created_by");
