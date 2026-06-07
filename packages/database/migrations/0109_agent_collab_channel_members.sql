-- Migration 0109: backfill agent_collab membership into channel_members
--
-- DATA BACKFILL ONLY — no schema change. The `channel_members` table already
-- exists (migration 0036 + capability-flag columns added later). This migration
-- unifies A2AI (agent_collab) membership with the typed `channel_members` table
-- so the per-member capability flags (can_draft / can_propose / can_act) that
-- the governance gate reads ALSO govern A2AI agent writes — instead of the
-- legacy untyped `metadata.participants: string[]` JSONB array.
--
-- For every agent_collab channel, each id in metadata.participants becomes a
-- channel_members row:
--   member_kind = 'ai_agent'   (A2AI participants are agent-users)
--   role        = 'member'
--   can_draft / can_propose / can_act → column defaults (true / true / false),
--     the conservative grant that matches today's reviewable behavior.
--
-- Idempotent (ON CONFLICT DO NOTHING against the unique (channel_id, member_id))
-- and defensive (guarded on table existence; skips null/empty participant arrays
-- and non-string elements).
--
-- NOTE: no BEGIN/COMMIT here — the migration runner (migrate.ts) wraps every
-- file in its own sql.begin() transaction; an inner COMMIT would break that.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'channel_members'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'channels'
    ) THEN
        INSERT INTO "channel_members" ("channel_id", "member_id", "member_kind", "role", "added_by")
        SELECT
            c."id"                AS channel_id,
            participant.value     AS member_id,
            'ai_agent'            AS member_kind,
            'member'              AS role,
            c."user_id"           AS added_by
        FROM "channels" c
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
                WHEN jsonb_typeof(c."metadata" -> 'participants') = 'array'
                    THEN c."metadata" -> 'participants'
                ELSE '[]'::jsonb
            END
        ) AS participant(value)
        WHERE c."channel_type" = 'agent_collab'
          AND participant.value IS NOT NULL
          AND length(trim(participant.value)) > 0
        ON CONFLICT ("channel_id", "member_id") DO NOTHING;
    END IF;
END;
$$;
