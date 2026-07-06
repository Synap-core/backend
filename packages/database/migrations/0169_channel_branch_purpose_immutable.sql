-- 0169: FIREWALL FLOOR — the 'client-comms' role is immutable at the DB layer.
--
-- A CHECK constraint cannot see OLD.branch_purpose, so a BEFORE UPDATE trigger is
-- the only true floor against the client-comms -> (team|null|other) transition.
-- Legal transitions still allowed: NULL->client-comms, team->client-comms,
-- client-comms->client-comms (filtered by the WHEN clause), and every
-- non-client-comms transition. Only reclassifying AWAY from client-comms is
-- refused — regardless of app code, raw SQL, or which package issued the write.

CREATE OR REPLACE FUNCTION synap_guard_branch_purpose_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.branch_purpose = 'client-comms'
     AND NEW.branch_purpose IS DISTINCT FROM 'client-comms' THEN
    RAISE EXCEPTION
      'firewall: channel % branch_purpose ''client-comms'' is immutable — refused reclassify to %',
      OLD.id, COALESCE(NEW.branch_purpose, 'NULL')
      -- SQLSTATE 23514: setChannelBranchPurpose() catches this and rethrows
      -- ChannelFirewallImmutableError, which the HTTP callers map to 403. A raw
      -- SQL writer that bypasses the door gets the raw 23514 (still fail-closed).
      USING ERRCODE = 'check_violation';
  END IF;
  -- NOTE: a superuser session with `SET session_replication_role='replica'`
  -- disables origin triggers and can bypass this floor — superuser-only, out of
  -- the app's threat model.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channels_branch_purpose_immutable ON channels;
CREATE TRIGGER trg_channels_branch_purpose_immutable
  BEFORE UPDATE OF branch_purpose ON channels
  FOR EACH ROW
  WHEN (OLD.branch_purpose IS DISTINCT FROM NEW.branch_purpose)
  EXECUTE FUNCTION synap_guard_branch_purpose_immutable();
