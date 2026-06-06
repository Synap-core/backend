-- Migration 0044: pod-level AI provider registry
--
-- Stores provider configs (baseUrl, models, tiers, encrypted API key) at the
-- pod level — decoupled from workspaces and IntelligenceSystems. The backend
-- syncs this table to the active IS on every mutation.

CREATE TABLE IF NOT EXISTS "ai_providers" (
  "id"                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "provider_id"          text NOT NULL,
  "name"                 text NOT NULL,
  "base_url"             text NOT NULL,
  "api_key_env_var"      text NOT NULL,
  "encrypted_api_key"    text,
  "enabled"              boolean NOT NULL DEFAULT true,
  "priority"             integer NOT NULL DEFAULT 10,
  "tags"                 jsonb NOT NULL DEFAULT '[]',
  "models"               jsonb NOT NULL DEFAULT '[]',
  "rate_limit"           jsonb,
  "extra_body"           jsonb,
  "system_prompt_prefix" text,
  "metadata"             jsonb NOT NULL DEFAULT '{}',
  "created_at"           timestamp NOT NULL DEFAULT now(),
  "updated_at"           timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_provider_id_idx"
  ON "ai_providers" ("provider_id");
