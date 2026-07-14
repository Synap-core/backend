-- Handshake now enforces the least-privilege scope used for CP user exchange.
-- Existing managed Pods already trust their built-in CP, so backfill that scope
-- before the updated API begins rejecting otherwise-valid owner sessions.
DO $$
BEGIN
  IF to_regclass('public.trusted_issuers') IS NOT NULL THEN
    UPDATE "trusted_issuers"
    SET
      "allowed_scopes" = array_append("allowed_scopes", 'auth:exchange-user'),
      "updated_at" = now()
    WHERE
      "is_built_in" = true
      AND "status" = 'approved'
      AND NOT ('auth:exchange-user' = ANY("allowed_scopes"));
  END IF;
END $$;
