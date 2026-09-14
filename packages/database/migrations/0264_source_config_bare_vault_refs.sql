-- 0264_source_config_bare_vault_refs.sql
--
-- Repairs source-config vault references written as `vault://<uuid>/value`.
--
-- An inline secret provisioned through `POST /api/admin/source-configs` stores
-- the RAW string (secrets.service_id = 'source:admin-provisioned'). A `/value`
-- suffix makes the resolver parse that plaintext as JSON and read a field, which
-- fails, so the reference resolves to "" — a delivered relay key that can never
-- be read. The writer now stores a bare `vault://<uuid>`; this rewrites the rows
-- already written in the suffixed form.
--
-- Scope: only references to a secret with service_id 'source:admin-provisioned'
-- owned by the config's own user, and only the exact `/value` suffix, at any
-- depth of the config. Every other reference is left as it is.
--
-- Idempotent: a repaired row no longer contains the suffixed form.

DO $$
DECLARE
  s record;
BEGIN
  IF to_regclass('public.source_configs') IS NULL
     OR to_regclass('public.secrets') IS NULL THEN
    RETURN;
  END IF;

  FOR s IN
    SELECT id::text AS secret_id, user_id
    FROM secrets
    WHERE service_id = 'source:admin-provisioned'
  LOOP
    UPDATE source_configs
    SET config = replace(
      config::text,
      '"vault://' || s.secret_id || '/value"',
      '"vault://' || s.secret_id || '"'
    )::jsonb
    WHERE user_id = s.user_id
      AND strpos(config::text, '"vault://' || s.secret_id || '/value"') > 0;
  END LOOP;
END $$;
