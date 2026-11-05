-- 0401 — Proof of presence, slice 3 (W3, founder decision 2 of 4 Nov 2026):
-- adding or removing a passkey when the person already has a factor needs a
-- proof from an existing one. That proof consumes a `passkey_change:<user>`
-- challenge; Kratos' settings guard then REDEEMS it, once, within 5 min, so
-- one proof allows one passkey change. `redeemed_at` marks it redeemed.
--
-- Re-runnable: IF NOT EXISTS.

ALTER TABLE "presence_challenges"
  ADD COLUMN IF NOT EXISTS "redeemed_at" timestamptz;
