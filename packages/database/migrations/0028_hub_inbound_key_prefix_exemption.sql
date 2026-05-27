-- Migration: Relax api_keys prefix constraint for hub_inbound type keys
--
-- The api_keys_key_prefix_check constraint enforces a user-facing key naming
-- convention (synap_hub_live_, synap_hub_test_, synap_user_). This is correct
-- for user PATs but wrong for Hub Protocol inbound keys (hub_inbound type):
-- those are IS-generated keys that don't follow the same prefix format.
--
-- Before: ALL keys must have a prefix in the allowed set
-- After:  hub_inbound keys are exempt; user-facing key types still enforced

ALTER TABLE api_keys DROP CONSTRAINT api_keys_key_prefix_check;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_key_prefix_check CHECK (
  key_type = 'hub_inbound'
  OR key_prefix IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_')
);
