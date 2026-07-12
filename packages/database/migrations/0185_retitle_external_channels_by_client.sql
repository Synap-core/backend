-- Migration: 0185_retitle_external_channels_by_client  (W5 data cleanup)
--
-- Dogfooding the team pod (2026-07-11, after the channel-consolidation deploy) found
-- the external Discord channels are correctly LINKED to real client companies
-- (Weex, Quantos, Etee, …) with the right firewall roles — but they are still TITLED
-- after the Discord participant ("Discord · randomzip") or a raw channel snowflake.
-- That is the original "titled after the user, not the client" complaint: the LINK is
-- right, only the TITLE is stale. Link-at-birth already titles NEW inbound channels
-- after their client; this is the one-time pass that fixes the EXISTING ones.
--
-- SAFE + TARGETED: only external channels that are (a) bound to a LIVE entity and
-- (b) still carry an AUTO-GENERATED title (never a title a human deliberately set).
-- A 'team' channel gets a " — team" suffix so the team / client-comms sibling pair
-- for the same client stays distinguishable. Reversible in spirit (the prior titles
-- were auto-generated, not authored).

UPDATE channels c
SET title = CASE
      WHEN c.branch_purpose = 'team' THEN e.title || ' — team'
      ELSE e.title
    END,
    updated_at = now()
FROM entities e
WHERE c.channel_type = 'external'
  AND c.context_object_id = e.id
  AND e.deleted_at IS NULL
  AND e.title IS NOT NULL
  AND (
    c.title IS NULL
    OR c.title LIKE 'Discord · %'
    OR c.title LIKE 'Telegram · %'
    OR c.title ~ '^[0-9]{5,}$'       -- a raw provider snowflake id as the title
    OR c.title LIKE 'discord channel'
    OR c.title LIKE 'discord feed'
  );
