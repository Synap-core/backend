-- 0461: the devices registry (devices plan 767a5978 §3, P1; founder
-- decision 78fc3fa1: tables not entity kinds, internal namespace `fleet`).
--
-- A device is anything the person connects that describes itself: a
-- computer, a VM, a container, a cloud server, a disk, a phone, a printer, a
-- camera, a sensor. A computer that runs the Synap runner keeps its `users`
-- principal (`agent_type = 'machine'`): that row is the device's KEY, this
-- row is the THING. A printer or a VM with no runner never becomes a user.
--
--   kind            text with a shape check, never an enum: a new kind needs
--                   no migration (the list lives in
--                   `@synap-core/types/device-manifest`);
--   parent_device_id host → VM → container;
--   principal_user_id the machine user, when it runs the runner;
--   connection      {mode: agent | bridge | provider | manual, ...};
--   manifest        the device manifest (v1), merged section by section
--                   from every report;
--   capability_reports each reporting process's capabilities and report
--                   time: the device's capabilities are their live union;
--   labels          what `placement.labels` will read (P4);
--   last_report_at  when it last reported. Status (online, offline,
--                   degraded, unknown) is a READ verdict derived from it and
--                   the manifest's health, never a stored column.
--
-- `compute_leases.device_id`: a provisioned cloud server is a device (P4).
--
-- Backfill: one device per machine user (kind computer, connection agent),
-- its identity read from `agent_metadata` (hostname, platform, arch). One
-- device per principal is held by a unique index, so the backfill and the
-- enrolment door (`ensureComputerDevice`) can never make a second one.
-- Idempotent: runs twice to the same rows.

CREATE TABLE IF NOT EXISTS "devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id" text NOT NULL,
  "workspace_id" uuid,
  "belongs_to" text NOT NULL DEFAULT 'person',
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "parent_device_id" uuid,
  "principal_user_id" text,
  "connection" jsonb NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
  "manifest" jsonb,
  "capability_reports" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "labels" text[] NOT NULL DEFAULT '{}'::text[],
  "last_report_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "retired_at" timestamp with time zone,
  CONSTRAINT "devices_kind_check"
    CHECK ("kind" ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT "devices_belongs_to_check"
    CHECK ("belongs_to" IN ('person', 'agent', 'shared')),
  CONSTRAINT "devices_connection_mode_check"
    CHECK ("connection"->>'mode' IN ('agent', 'bridge', 'provider', 'manual')),
  CONSTRAINT "devices_name_check"
    CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "devices_not_own_parent_check"
    CHECK ("parent_device_id" IS NULL OR "parent_device_id" <> "id")
);

DO $$ BEGIN
  ALTER TABLE "devices" ADD CONSTRAINT "devices_parent_fk"
    FOREIGN KEY ("parent_device_id") REFERENCES "devices"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "devices" ADD CONSTRAINT "devices_principal_fk"
    FOREIGN KEY ("principal_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One device per principal, ever (a retired one keeps it: a reconnect
-- revives the same device, never a twin).
CREATE UNIQUE INDEX IF NOT EXISTS "devices_principal_uidx"
  ON "devices" ("principal_user_id") WHERE "principal_user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "devices_owner_idx"
  ON "devices" ("owner_user_id");

CREATE INDEX IF NOT EXISTS "devices_workspace_idx"
  ON "devices" ("workspace_id") WHERE "workspace_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "devices_parent_idx"
  ON "devices" ("parent_device_id") WHERE "parent_device_id" IS NOT NULL;

ALTER TABLE "compute_leases" ADD COLUMN IF NOT EXISTS "device_id" uuid;

DO $$ BEGIN
  ALTER TABLE "compute_leases" ADD CONSTRAINT "compute_leases_device_fk"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: every computer that has a person behind it. Its name is the one
-- the person reads (`machineName`: the user's name, else its hostname).
INSERT INTO "devices" (
  "owner_user_id", "belongs_to", "kind", "name", "principal_user_id",
  "connection", "manifest", "created_at", "updated_at"
)
SELECT
  u."created_by_user_id",
  COALESCE(u."computer_belongs_to", 'person'),
  'computer',
  LEFT(COALESCE(
    NULLIF(btrim(u."name"), ''),
    NULLIF(btrim(u."agent_metadata"->>'hostname'), ''),
    'Computer'
  ), 200),
  u."id",
  '{"mode":"agent"}'::jsonb,
  jsonb_build_object(
    'manifestVersion', 1,
    'identity', jsonb_strip_nulls(jsonb_build_object(
      'hostname', LEFT(NULLIF(btrim(u."agent_metadata"->>'hostname'), ''), 253),
      'os', LEFT(NULLIF(btrim(u."agent_metadata"->>'platform'), ''), 64),
      'arch', LEFT(NULLIF(btrim(u."agent_metadata"->>'arch'), ''), 32)
    ))
  ),
  COALESCE(u."created_at", now()),
  now()
FROM "users" u
WHERE u."agent_type" = 'machine'
  AND u."created_by_user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "devices" d WHERE d."principal_user_id" = u."id"
  );
