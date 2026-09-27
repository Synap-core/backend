-- 0279: one conversation per object (Documents v2, lane C-comments).
--
-- Founder model (2026-09-25/26): every object has ONE linked channel — its
-- "object room" — and a document comment is a message in it, anchored to a
-- block (`messages.metadata.anchor`, the D19 contract extended). Comments can
-- be resolved.
--
-- 1. `messages.resolved_at` / `resolved_by` — resolve is state on the thread's
--    ROOT message (lead default: a real column, so the open-comment count is an
--    indexed read, not a JSONB scan). Written only by the comments door.
--
-- 2. `channels_object_room_lens_uniq` — at most ONE active room per object per
--    LENS. The ONE mint (`ChannelRepository.ensureObjectChannel`) inserts with
--    ON CONFLICT DO NOTHING and re-selects, so two concurrent opens converge.
--    The lens (founder decision 2026-09-27) is `metadata.lensWorkspaceId`:
--      - absent → the object's SHARED room (every comment; pod-wide recaps),
--        visible to whoever may read the object;
--      - a workspace id → a workspace-scoped recap room, visible to the
--        object's readers who ALSO belong to that workspace.
--    The predicate MUST mirror the drizzle declaration in `schema/channels.ts`
--    and the baseline.
--
--    No row can violate it today: no door before this migration minted a GROUP
--    channel stamped document|entity. The dedup below is a guard only — oldest
--    wins per (object, lens), the rest are marked `merged` (0182 precedent).
--    The first draft of this file named the index `channels_object_room_uniq`
--    and keyed it without the lens; it is dropped here in case a dev pod ran
--    that draft.

-- 3. `messages_open_comment_root_idx` — the unresolved-comment count per room.
--
-- Idempotent throughout.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "resolved_by" text;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY context_object_type, context_object_id,
                        COALESCE(metadata ->> 'lensWorkspaceId', '')
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM channels
  WHERE channel_type = 'group'
    AND status = 'active'
    AND context_object_type IN ('document', 'entity')
    AND context_object_id IS NOT NULL
)
UPDATE channels c
SET status = 'merged', updated_at = now()
FROM ranked r
WHERE c.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS "channels_object_room_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "channels_object_room_lens_uniq"
  ON "channels" (
    "context_object_type",
    "context_object_id",
    (COALESCE("metadata" ->> 'lensWorkspaceId', ''))
  )
  WHERE "channel_type" = 'group'
    AND "status" = 'active'
    AND "context_object_type" IN ('document', 'entity');

CREATE INDEX IF NOT EXISTS "messages_open_comment_root_idx"
  ON "messages" ("channel_id")
  WHERE "parent_id" IS NULL
    AND "resolved_at" IS NULL
    AND "deleted_at" IS NULL
    AND ("metadata" -> 'anchor') IS NOT NULL;
