-- 0265_source_config_bare_vault_refs_retagged.sql
--
-- Repairs source-config vault references written as `vault://<uuid>/value`
-- where the secret carries the service id the source-config door leaves on it.
--
-- `POST /api/admin/source-configs` inserts each inline secret with
-- service_id 'source:admin-provisioned', then re-tags it to
-- 'source:<source_config id>' in the same transaction. The stored plaintext is
-- the RAW string, so a `/value` suffix makes the resolver parse it as JSON and
-- read a field, which fails and resolves to "". 0264 matched only the
-- pre-re-tag service id, which no committed row carries.
--
-- Scope: a reference in source config `c` to secret `s` where s.user_id =
-- c.user_id AND s.service_id is 'source:' || c.id (the committed shape) or
-- 'source:admin-provisioned' (the pre-re-tag shape). Only the exact `/value`
-- suffix is rewritten, at any depth of the config. Every other reference is
-- left as it is.
--
-- Idempotent: a repaired row no longer contains the suffixed form.

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.source_configs') IS NULL
     OR to_regclass('public.secrets') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.id AS config_id, s.id::text AS secret_id
    FROM source_configs c
    JOIN secrets s
      ON s.user_id = c.user_id
     AND (s.service_id = 'source:' || c.id::text
          OR s.service_id = 'source:admin-provisioned')
    WHERE strpos(c.config::text, '"vault://' || s.id::text || '/value"') > 0
  LOOP
    UPDATE source_configs
    SET config = replace(
      config::text,
      '"vault://' || r.secret_id || '/value"',
      '"vault://' || r.secret_id || '"'
    )::jsonb
    WHERE id = r.config_id;
  END LOOP;
END $$;
