-- 0150 — Provider Integrations Registry + secrets.provider_integration_id FK
--
-- Two new metadata-only tables + one nullable FK on `secrets`:
--   providers              — credential backend platforms (Nango, Vault, Unipile…)
--   provider_integrations  — specific services each provider exposes
--                            (gmail, gdrive, outlook under Nango;
--                             openai, apify, apollo under Vault)
--   secrets.provider_integration_id — nullable FK: when set, the vault secret
--     routes through the linked provider's credential lifecycle (OAuth refresh,
--     proxy) instead of being injected as a raw API key.
--
-- Design: ADDITIVE only. Existing nango:// credentialRef tools are untouched
-- (backward-compat nangoHandler stays). New tools use
-- credentialRef = vault://<secretId> where the secret carries the
-- provider_integration_id FK. Null provider_integration_id → existing vault
-- injection behavior.
--
-- Part of the Playbooks & Capability Substrate (Approach B — vault-centric,
-- provider as metadata).

-- ── providers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "providers" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"            text NOT NULL UNIQUE,
  "display_name"    text NOT NULL,
  "description"     text,
  "backend_type"    text NOT NULL,
  "logo_url"        text,
  "metadata"        jsonb NOT NULL DEFAULT '{}',
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_providers_backend_type ON "providers" ("backend_type");

-- ── provider_integrations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "provider_integrations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_id"     uuid NOT NULL REFERENCES "providers"("id") ON DELETE CASCADE,
  "slug"            text NOT NULL,
  "display_name"    text NOT NULL,
  "description"     text,
  "backend_config"  jsonb NOT NULL DEFAULT '{}',
  "logo_url"        text,
  "metadata"        jsonb NOT NULL DEFAULT '{}',
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_integrations_provider_id
  ON "provider_integrations" ("provider_id");

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_integrations_provider_slug
  ON "provider_integrations" ("provider_id", "slug");

-- ── secrets.provider_integration_id FK ────────────────────────────────────────
ALTER TABLE "secrets"
  ADD COLUMN IF NOT EXISTS "provider_integration_id" uuid
  REFERENCES "provider_integrations"("id");

CREATE INDEX IF NOT EXISTS idx_secrets_provider_integration
  ON "secrets" ("provider_integration_id");

-- ── Seed providers ────────────────────────────────────────────────────────────
-- Nango: OAuth proxy (token refresh, connection management).
INSERT INTO "providers" ("slug", "display_name", "description", "backend_type")
VALUES (
  'nango',
  'Nango',
  'OAuth proxy for third-party API connections — token refresh, connection management, generic proxy.',
  'nango'
) ON CONFLICT ("slug") DO NOTHING;

-- Vault: direct API key injection (server-encrypted).
INSERT INTO "providers" ("slug", "display_name", "description", "backend_type")
VALUES (
  'vault',
  'Synap Vault',
  'Server-encrypted API key storage — direct injection into config-driven HTTP calls.',
  'vault'
) ON CONFLICT ("slug") DO NOTHING;

-- Unipile: messaging gateway.
INSERT INTO "providers" ("slug", "display_name", "description", "backend_type")
VALUES (
  'unipile',
  'Unipile',
  'Unified messaging gateway — LinkedIn, WhatsApp, Gmail, and more.',
  'unipile'
) ON CONFLICT ("slug") DO NOTHING;

-- Note: Nango provider integrations (gmail, gdrive, outlook, slack, etc.) are
-- seeded dynamically at runtime from Nango's own integration registry, not here.
-- Vault provider integrations (openai, apify, apollo, etc.) are seeded manually
-- when a new API-key service is added. This migration seeds the providers table
-- only — integrations are populated by the tool-seeding / capability-apply flow.
