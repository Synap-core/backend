-- 0427 — per-LinkedIn-account daily limits, in the caps fold (0330).
--
-- Two new `governance_ceilings` axes, read through `resolveCeiling` with the
-- messaging account as SUBJECT (`subject_type` 'messaging_account',
-- `subject_id` = its row id):
--   linkedin_invitations_daily  connection requests one account sends per UTC day
--   linkedin_actions_daily      messages + connection requests per UTC day
-- Their defaults (20, 50) live in `CEILING_DEFAULTS` (@synap/governance-policy);
-- a row for one account sets another value. A send past either is HELD and
-- goes the next day (`services/channels/linkedin-account-limits.ts`). The day's
-- count lives on the account (`messaging_accounts.metadata.linkedinDaily`), as
-- the profile-lookup budget does.
--
-- TRANSACTION NOTE: as 0330 — `ALTER TYPE … ADD VALUE` is legal inside the
-- migration transaction on Postgres 12+ when the value is not used in it.
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'linkedin_invitations_daily';
ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'linkedin_actions_daily';
