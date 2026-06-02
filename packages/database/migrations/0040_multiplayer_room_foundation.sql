-- Migration 0040: multiplayer room foundation (Wave 1)
--
-- Owns ALL schema fields the multiplayer channels ("The Room") feature needs so
-- the later routing-engine pass can land with NO further migration. Three areas:
--
--   1. channels.ai_reaction_mode        — per-channel "how AI teammates react"
--                                          control (routing hint, NOT a write gate).
--   2. channel_members capability flags  — per-teammate can_draft / can_propose /
--                                          can_act, the effective per-channel grant
--                                          that feeds the governance gate.
--   3. messages routed-attribution       — routed_teammate_id (FK → users) +
--                                          routed_source, so the UI can render
--                                          "orchestrator routed to X".
--
-- Conservative-by-default: capability flags default to draft+propose but NOT act,
-- so an unconfigured teammate can never auto-commit to the pod. Idempotent
-- throughout (IF NOT EXISTS / guarded FK), matching 0036/0038/0039.

BEGIN;

-- 1. channels.ai_reaction_mode -----------------------------------------------
ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "ai_reaction_mode" text NOT NULL DEFAULT 'when_confident';

-- 2. channel_members per-teammate capability flags ---------------------------
ALTER TABLE "channel_members"
  ADD COLUMN IF NOT EXISTS "can_draft"   boolean NOT NULL DEFAULT true;
ALTER TABLE "channel_members"
  ADD COLUMN IF NOT EXISTS "can_propose" boolean NOT NULL DEFAULT true;
ALTER TABLE "channel_members"
  ADD COLUMN IF NOT EXISTS "can_act"     boolean NOT NULL DEFAULT false;

-- 3. messages routed-attribution ---------------------------------------------
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "routed_teammate_id" text;
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "routed_source" text;

-- FK: routed_teammate_id → users(id). ON DELETE SET NULL keeps attribution
-- orphan-safe if a teammate user row is removed. Idempotent (guarded).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_routed_teammate_id_fkey'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_routed_teammate_id_fkey"
      FOREIGN KEY ("routed_teammate_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Per-teammate attribution dashboard lookup ("messages this teammate authored").
CREATE INDEX IF NOT EXISTS "messages_routed_teammate_idx"
  ON "messages" ("routed_teammate_id")
  WHERE "routed_teammate_id" IS NOT NULL;

COMMIT;
