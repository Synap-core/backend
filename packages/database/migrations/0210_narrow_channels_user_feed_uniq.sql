-- Migration: 0210_narrow_channels_user_feed_uniq
--
-- ROOT CAUSE: 0182 added
--   CREATE UNIQUE INDEX channels_user_feed_uniq ON channels (user_id)
--     WHERE channel_type='feed' AND status='active';
-- on the premise that the proactive briefing feed is the ONLY feed-typed channel,
-- so one-per-user is correct. That premise is FALSE. Automation run-recap channels
-- (ChannelRepository.ensureAutomationRunChannel) are ALSO channel_type='feed'
-- (feedScope 'automation results' — the intended vehicle), one per automation via
-- context_object_type='automation' + context_object_id=<automationId>.
--
-- Consequence: once a user has BOTH a proactive feed AND any automation-run feed,
-- every subsequent automation-run channel create hits 23505 unique_violation on
-- channels_user_feed_uniq (create() has no onConflict). The channel is never
-- created, so the automation fails, and it re-collides on the NEXT run — a
-- self-perpetuating failure (observed: 0/N automation runs succeed).
--
-- FIX: narrow the index so it only dedupes the TRUE proactive feed. The proactive
-- feed carries context_object_type IS NULL; automation-run feeds carry
-- context_object_type='automation'. That NULL is the discriminator. After
-- narrowing, automation-run feeds are unconstrained by this index (they are
-- deduped in code via findAutomationRunChannel on context_object_id), while the
-- one-proactive-feed-per-user guarantee is preserved.
--
-- A resolver-side onConflict on (user_id) would MIS-ROUTE (the arbiter would
-- return the proactive feed, not the automation's channel), so narrowing the index
-- — not adding onConflict to the feed create path — is the canonical fix.
--
-- Idempotent.

DROP INDEX IF EXISTS channels_user_feed_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS channels_user_feed_uniq
  ON channels (user_id)
  WHERE channel_type = 'feed'
    AND status = 'active'
    AND context_object_type IS NULL;
