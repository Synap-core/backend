-- 0399: installations — capabilities installed on the person's own computers
-- (Stage 1 of "capabilities that install on your computers": design ccd509f8,
-- addendum 000e75ff §6, build plan 64072312 unit U4).
--
-- Four tables:
--   installations          one capability on one computer: the manifest as
--                          approved, its image digests, the computer, the
--                          owner, its key, its status. Never deleted: a
--                          removed installation stays as history.
--   installation_bindings  one need of an installation served by one provider
--                          capability, resolved by intent (url, handle, the
--                          auth mode the provider enforces, public or not).
--   host_jobs              one job for the host runner on a computer (install,
--                          remove, update, provider_op, verb). The lease shape
--                          is box_runs' (0356): lease_id minted at each lease,
--                          heartbeat/report/finish must present it; a running
--                          job whose lease expired is READ as stalled.
--   intent_defaults        the provider a person chose to remember for an
--                          intent + constraints. `public` is never remembered
--                          (CHECK below, addendum §7 rule 1).
--
-- `intent` is plain text everywhere, no enum and no foreign key: the intent
-- vocabulary is open (capability_intents), and the Stage 1 slugs wait on the
-- founder's naming decision (F1).
--
-- Stored statuses only. `stalled` (a job) and "degraded by a missed
-- heartbeat" (an installation) are READ verdicts, never stored.
--
-- Read floor: the owner (`user_id`) within the workspace lens, as box_runs;
-- intent_defaults is the person's alone (access/registry.ts). The computer
-- reads its jobs only through the host-job routes (`host.runner` scope).

CREATE TABLE IF NOT EXISTS "installations" (
  "id"                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            text        NOT NULL,
  "workspace_id"       uuid,
  "capability_id"      uuid        REFERENCES "capabilities"("id") ON DELETE SET NULL,
  "capability_key"     text        NOT NULL,
  "capability_version" text,
  "upstream_version"   text,
  "machine_user_id"    text        NOT NULL,
  "agent_user_id"      text,
  "api_key_id"         uuid        REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "proposal_id"        uuid,
  "manifest"           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "digests"            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "status"             text        NOT NULL DEFAULT 'planned',
  "status_detail"      text,
  "health"             jsonb,
  "last_report_at"     timestamptz,
  "installed_at"       timestamptz,
  "removed_at"         timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'installations_status_check'
  ) THEN
    ALTER TABLE "installations" ADD CONSTRAINT "installations_status_check"
      CHECK ("status" IN ('planned', 'installing', 'healthy', 'degraded', 'updating', 'failed', 'removing', 'removed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_installations_user"
  ON "installations" ("user_id", "created_at" DESC);

-- What runs on a computer (Installed here, revokeMachine's cascade).
CREATE INDEX IF NOT EXISTS "idx_installations_machine"
  ON "installations" ("machine_user_id")
  WHERE "status" <> 'removed';

CREATE INDEX IF NOT EXISTS "idx_installations_capability"
  ON "installations" ("capability_id")
  WHERE "capability_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "installation_bindings" (
  "id"                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "installation_id"        uuid        NOT NULL REFERENCES "installations"("id") ON DELETE CASCADE,
  "user_id"                text        NOT NULL,
  "workspace_id"           uuid,
  "need_key"               text        NOT NULL,
  "intent"                 text        NOT NULL,
  "provider_capability_id" uuid        REFERENCES "capabilities"("id") ON DELETE SET NULL,
  "agent_user_id"          text,
  "api_key_id"             uuid        REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "handle"                 jsonb,
  "url"                    text,
  "state"                  text        NOT NULL DEFAULT 'pending',
  "auth_requested"         text,
  "auth_applied"           text,
  "public"                 boolean     NOT NULL DEFAULT false,
  "expires_at"             timestamptz,
  "checked_at"             timestamptz,
  "detail"                 text,
  "revoked_at"             timestamptz,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'installation_bindings_state_check'
  ) THEN
    ALTER TABLE "installation_bindings" ADD CONSTRAINT "installation_bindings_state_check"
      CHECK ("state" IN ('pending', 'live', 'degraded', 'revoked', 'failed'));
  END IF;
END $$;

-- No UNIQUE on (installation, need): a rebind holds the old binding live
-- until the new one is.
CREATE INDEX IF NOT EXISTS "idx_installation_bindings_need"
  ON "installation_bindings" ("installation_id", "need_key");

CREATE INDEX IF NOT EXISTS "idx_installation_bindings_provider"
  ON "installation_bindings" ("provider_capability_id")
  WHERE "provider_capability_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "host_jobs" (
  "id"                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"               text        NOT NULL,
  "installation_id"    uuid        NOT NULL REFERENCES "installations"("id") ON DELETE CASCADE,
  "binding_id"         uuid        REFERENCES "installation_bindings"("id") ON DELETE SET NULL,
  "skill_id"           uuid        REFERENCES "skills"("id") ON DELETE SET NULL,
  "user_id"            text        NOT NULL,
  "machine_user_id"    text        NOT NULL,
  "agent_user_id"      text,
  "session_id"         uuid,
  "workspace_id"       uuid,
  "proposal_id"        uuid,
  "spec"               jsonb       NOT NULL,
  "parameters"         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "status"             text        NOT NULL DEFAULT 'queued',
  "attempt"            integer     NOT NULL DEFAULT 0,
  "leased_by"          text,
  "lease_id"           uuid,
  "lease_expires_at"   timestamptz,
  "last_heartbeat_at"  timestamptz,
  "stop_requested_at"  timestamptz,
  "logs_requested_at"  timestamptz,
  "log"                jsonb,
  "log_received_at"    timestamptz,
  "evidence"           jsonb,
  "error"              text,
  "queued_at"          timestamptz NOT NULL DEFAULT now(),
  "leased_at"          timestamptz,
  "started_at"         timestamptz,
  "finished_at"        timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'host_jobs_kind_check'
  ) THEN
    ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_kind_check"
      CHECK ("kind" IN ('install', 'remove', 'update', 'provider_op', 'verb'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'host_jobs_status_check'
  ) THEN
    ALTER TABLE "host_jobs" ADD CONSTRAINT "host_jobs_status_check"
      CHECK ("status" IN ('queued', 'leased', 'running', 'done', 'failed', 'stopped'));
  END IF;
END $$;

-- The queue head, per computer (FIFO by queued_at): a computer leases only
-- the jobs of installations on itself.
CREATE INDEX IF NOT EXISTS "idx_host_jobs_queue"
  ON "host_jobs" ("machine_user_id", "queued_at")
  WHERE "status" IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS "idx_host_jobs_installation"
  ON "host_jobs" ("installation_id", "queued_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_host_jobs_user_queued"
  ON "host_jobs" ("user_id", "queued_at" DESC);

CREATE TABLE IF NOT EXISTS "intent_defaults" (
  "id"                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                text        NOT NULL,
  "workspace_id"           uuid,
  "intent"                 text        NOT NULL,
  "constraints_hash"       text        NOT NULL DEFAULT '',
  "constraints"            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "provider_capability_id" uuid        NOT NULL REFERENCES "capabilities"("id") ON DELETE CASCADE,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "intent_defaults_scope_unique" UNIQUE NULLS NOT DISTINCT
    ("user_id", "workspace_id", "intent", "constraints_hash")
);

-- `public` is never a remembered choice (addendum §7 rule 1): refuse
-- constraints whose `auth` is, lists, or allows (anyOf) `public`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'intent_defaults_never_public_check'
  ) THEN
    ALTER TABLE "intent_defaults" ADD CONSTRAINT "intent_defaults_never_public_check"
      CHECK (
        NOT coalesce(("constraints" -> 'auth') ? 'public', false)
        AND NOT coalesce(("constraints" -> 'auth' -> 'anyOf') ? 'public', false)
      );
  END IF;
END $$;
